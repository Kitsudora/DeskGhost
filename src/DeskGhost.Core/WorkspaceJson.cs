using System.Text.Json;
using System.Text.Json.Serialization;

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
            throw new WorkspaceValidationException("工作区无法序列化，请检查数据。", error);
        }
    }

    internal static Workspace Deserialize(byte[] bytes)
    {
        WorkspaceValidator.Require(bytes.Length is > 0 and <= WorkspaceLimits.MaxFileBytes,
            $"工作区文件为空或超过 {WorkspaceLimits.MaxFileBytes / 1024 / 1024} MiB 限制。");
        try
        {
            RejectDuplicateProperties(bytes);
            var workspace = JsonSerializer.Deserialize<Workspace>(bytes, Options);
            WorkspaceValidator.Validate(workspace!);
            return workspace!;
        }
        catch (JsonException error)
        {
            throw new WorkspaceValidationException("工作区文件格式损坏或含有无效字段，原文件未被修改。", error);
        }
    }

    private static void RejectDuplicateProperties(byte[] bytes)
    {
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 16 });
        var objects = new Stack<HashSet<string>>();
        var rootProperty = "";
        var taskProperty = "";
        var rootArrayCount = 0;
        var archiveCount = 0;
        while (reader.Read())
        {
            string? propertyName = null;
            if (reader.TokenType == JsonTokenType.PropertyName)
            {
                WorkspaceValidator.Require(reader.ValueSpan.Length <= 128,
                    "文件字段名称超出允许长度，已停止读取。");
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
                WorkspaceValidator.Require(++rootArrayCount <= limit, "文件中的集合数量超出限制，已停止读取。");
            }
            if (reader.CurrentDepth == 4 && rootProperty == "tasks" && taskProperty == "archiveHistory"
                && StartsValue(reader.TokenType))
                WorkspaceValidator.Require(++archiveCount <= WorkspaceLimits.MaxArchiveEventsPerTask,
                    "任务归档历史数量超出限制，已停止读取。");
            if (reader.TokenType == JsonTokenType.StartObject)
                objects.Push(new HashSet<string>(StringComparer.Ordinal));
            else if (reader.TokenType == JsonTokenType.EndObject)
                objects.Pop();
            else if (reader.TokenType == JsonTokenType.PropertyName)
            {
                var properties = objects.Peek();
                if (!properties.Add(propertyName!)) throw new JsonException("Duplicate property.");
                WorkspaceValidator.Require(properties.Count <= 16,
                    "文件对象字段数量超出允许范围，已停止读取。");
            }
        }
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
                throw new WorkspaceValidationException($"工作区文件不能超过 {WorkspaceLimits.MaxFileBytes / 1024 / 1024} MiB；本次更改未保存。");
        }
    }
}
