using System.Text.Json.Serialization;

namespace DeskGhost.Core;

public enum TaskState { NotStarted, InProgress, Completed, Stopped }
public enum ArchiveAction { Archived, Unarchived }

public sealed class ArchiveEvent
{
    [JsonRequired] public DateTimeOffset At { get; set; }
    [JsonRequired] public ArchiveAction Action { get; set; }
}

public sealed class TaskCard
{
    [JsonRequired] public Guid Id { get; set; } = Guid.NewGuid();
    [JsonRequired] public string Title { get; set; } = "";
    [JsonRequired] public string Description { get; set; } = "";
    [JsonRequired] public string Notes { get; set; } = "";
    [JsonRequired] public DateTimeOffset? CreatedAt { get; set; }
    [JsonRequired] public string Category { get; set; } = "";
    [JsonRequired] public TaskState State { get; set; }
    [JsonRequired] public int Column { get; set; }
    [JsonRequired] public int Row { get; set; }
    [JsonRequired] public bool IsArchived { get; set; }
    [JsonRequired] public DateTimeOffset? DeletedAt { get; set; }
    [JsonRequired] public List<ArchiveEvent> ArchiveHistory { get; set; } = [];
}

public sealed class TaskLink
{
    [JsonRequired] public Guid SourceId { get; set; }
    [JsonRequired] public Guid TargetId { get; set; }
}

/// <summary>A versioned, portable workspace document. Mutate through WorkspaceSession.</summary>
public sealed class Workspace
{
    [JsonRequired] public int FormatVersion { get; set; } = WorkspaceLimits.CurrentFormatVersion;
    [JsonRequired] public Guid Id { get; set; } = Guid.NewGuid();
    [JsonRequired] public string Name { get; set; } = "New workspace";
    [JsonRequired] public List<string> Categories { get; set; } = [];
    [JsonRequired] public List<string> Columns { get; set; } = ["Slice 1"];
    [JsonRequired] public List<TaskCard> Tasks { get; set; } = [];
    [JsonRequired] public List<TaskLink> Links { get; set; } = [];

    public static Workspace CreateNew(string name)
    {
        var workspace = new Workspace { Name = name?.Trim()! };
        WorkspaceValidator.Validate(workspace);
        return workspace;
    }

    public Workspace DeepClone() => WorkspaceJson.Deserialize(WorkspaceJson.Serialize(this));
}

public static class WorkspaceLimits
{
    public const int CurrentFormatVersion = 2;
    public const int MaxFileBytes = 16 * 1024 * 1024;
    public const int MaxTasks = 2_000;
    public const int MaxLinks = 8_000;
    public const int MaxColumns = 256;
    public const int MaxCategories = 256;
    public const int MaxTitleLength = 256;
    public const int MaxDescriptionLength = 16_000;
    public const int MaxNotesLength = 32_000;
    public const int MaxCategoryLength = 80;
    public const int MaxNameLength = 120;
    public const int MaxColumnLabelLength = 80;
    public const int MaxRow = 4_095;
    public const int MaxArchiveEventsPerTask = 200;
    public const int MaxSourcesPerCreation = 256;
    public const int MaxHistoryEntries = 50;
    public const int MaxHistoryBytes = 32 * 1024 * 1024;
}

public class WorkspaceValidationException(string message, Exception? innerException = null)
    : Exception(message, innerException);

public class WorkspaceStorageException(string message, Exception? innerException = null)
    : IOException(message, innerException);

public sealed class WorkspaceConflictException(string message)
    : WorkspaceStorageException(message);
