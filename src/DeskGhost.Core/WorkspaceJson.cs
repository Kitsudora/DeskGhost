using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace DeskGhost.Core;

internal static class WorkspaceJson
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        WriteIndented = true,
        MaxDepth = 16,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter(allowIntegerValues: false) }
    };
    private static readonly JsonSerializerOptions LegacyOptions = new(Options)
    {
        TypeInfoResolver = new DefaultJsonTypeInfoResolver
        {
            Modifiers =
            {
                info =>
                {
                    if (info.Type != typeof(TaskCard)) return;
                    // Version 1 never recorded these fields. Keep its original
                    // strict schema and leave their defaults empty/unknown.
                    foreach (var property in info.Properties.Where(p => p.Name is "notes" or "createdAt").ToArray())
                        info.Properties.Remove(property);
                }
            }
        }
    };

    internal static byte[] Serialize(Workspace workspace)
    {
        WorkspaceValidator.Validate(workspace);
        try
        {
            // Bound output as it is produced, including escaped Unicode expansion.
            using var stream = new LimitedMemoryStream();
            JsonSerializer.Serialize(stream, workspace, Options);
            return stream.ToArray();
        }
        catch (JsonException error)
        {
            throw new WorkspaceValidationException("The workspace could not be serialized. Check its data.", error);
        }
    }

    internal static Workspace Deserialize(byte[] bytes)
    {
        WorkspaceValidator.Require(bytes.Length is > 0 and <= WorkspaceLimits.MaxFileBytes,
            $"The workspace file is empty or exceeds {WorkspaceLimits.MaxFileBytes / 1024 / 1024} MiB.");
        try
        {
            var version = ValidateStructure(bytes);
            WorkspaceValidator.Require(version is 1 or WorkspaceLimits.CurrentFormatVersion,
                $"Unsupported workspace format version {version}; open it with a compatible application.");
            var workspace = JsonSerializer.Deserialize<Workspace>(bytes, version == 1 ? LegacyOptions : Options);
            // Reading never writes the source file. Its original bytes become
            // the normal .bak when the first subsequent edit is saved as v2.
            if (version == 1 && workspace is not null) workspace.FormatVersion = WorkspaceLimits.CurrentFormatVersion;
            WorkspaceValidator.Validate(workspace!);
            return workspace!;
        }
        catch (JsonException error)
        {
            throw new WorkspaceValidationException("The workspace file is malformed or contains invalid fields. The original file is unchanged.", error);
        }
    }

    private static int? ValidateStructure(byte[] bytes)
    {
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 16 });
        var objects = new Stack<HashSet<string>>();
        var rootProperty = "";
        var taskProperty = "";
        var rootArrayCount = 0;
        var archiveCount = 0;
        int? version = null;
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.Number && reader.CurrentDepth == 1 && rootProperty == "formatVersion" && reader.TryGetInt32(out var value))
                version = value;
            string? propertyName = null;
            if (reader.TokenType == JsonTokenType.PropertyName)
            {
                WorkspaceValidator.Require(reader.ValueSpan.Length <= 128,
                    "A file field name exceeds the allowed length. Reading was stopped.");
                propertyName = reader.GetString()!;
                if (reader.CurrentDepth == 1) rootProperty = propertyName;
                if (reader.CurrentDepth == 3) taskProperty = propertyName;
            }
            if (reader.TokenType == JsonTokenType.StartArray && reader.CurrentDepth == 1)
                rootArrayCount = 0;
            if (reader.TokenType == JsonTokenType.StartArray && reader.CurrentDepth == 3)
                archiveCount = 0;
            if (reader.CurrentDepth == 2 && StartsValue(reader.TokenType))
            {
                var limit = rootProperty switch
                {
                    "tasks" => WorkspaceLimits.MaxTasks,
                    "links" => WorkspaceLimits.MaxLinks,
                    "columns" => WorkspaceLimits.MaxColumns,
                    "categories" => WorkspaceLimits.MaxCategories,
                    _ => WorkspaceLimits.MaxLinks
                };
                WorkspaceValidator.Require(++rootArrayCount <= limit, "A collection in the file exceeds its item limit. Reading was stopped.");
            }
            if (reader.CurrentDepth == 4 && rootProperty == "tasks" && taskProperty == "archiveHistory"
                && StartsValue(reader.TokenType))
                WorkspaceValidator.Require(++archiveCount <= WorkspaceLimits.MaxArchiveEventsPerTask,
                    "Task archive history exceeds its limit. Reading was stopped.");
            if (reader.TokenType == JsonTokenType.StartObject)
                objects.Push(new HashSet<string>(StringComparer.Ordinal));
            else if (reader.TokenType == JsonTokenType.EndObject)
                objects.Pop();
            else if (reader.TokenType == JsonTokenType.PropertyName)
            {
                var properties = objects.Peek();
                if (!properties.Add(propertyName!)) throw new JsonException("Duplicate property.");
                WorkspaceValidator.Require(properties.Count <= 16,
                    "An object in the file has too many fields. Reading was stopped.");
            }
        }
        return version;
    }

    private static bool StartsValue(JsonTokenType type) => type is JsonTokenType.StartObject
        or JsonTokenType.StartArray or JsonTokenType.String or JsonTokenType.Number
        or JsonTokenType.True or JsonTokenType.False or JsonTokenType.Null;

    private sealed class LimitedMemoryStream : MemoryStream
    {
        public override void Write(byte[] buffer, int offset, int count)
        {
            CheckSize(count);
            base.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            CheckSize(buffer.Length);
            base.Write(buffer);
        }

        private void CheckSize(int count)
        {
            if (Length + count > WorkspaceLimits.MaxFileBytes)
                throw new WorkspaceValidationException($"Workspace files cannot exceed {WorkspaceLimits.MaxFileBytes / 1024 / 1024} MiB. This change was not saved.");
        }
    }
}
