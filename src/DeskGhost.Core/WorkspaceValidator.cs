namespace DeskGhost.Core;

public static class WorkspaceValidator
{
    public static void Validate(Workspace workspace)
    {
        Require(workspace is not null, "Workspace data is required.");
        Require(workspace!.FormatVersion == WorkspaceLimits.CurrentFormatVersion,
            $"Unsupported workspace format version {workspace.FormatVersion}; open it with a compatible application.");
        Require(workspace.Id != Guid.Empty, "The workspace ID is invalid.");
        Text(workspace.Name, WorkspaceLimits.MaxNameLength, "Workspace name", required: true);
        Require(workspace.Categories is not null && workspace.Categories.Count <= WorkspaceLimits.MaxCategories,
            $"There can be at most {WorkspaceLimits.MaxCategories} categories.");
        Require(workspace.Columns is not null && workspace.Columns.Count is > 0 and <= WorkspaceLimits.MaxColumns,
            $"A workspace must contain between 1 and {WorkspaceLimits.MaxColumns} logical slices.");
        Require(workspace.Tasks is not null && workspace.Tasks.Count <= WorkspaceLimits.MaxTasks,
            $"There can be at most {WorkspaceLimits.MaxTasks} tasks, including archived and trashed tasks.");
        Require(workspace.Links is not null && workspace.Links.Count <= WorkspaceLimits.MaxLinks,
            $"There can be at most {WorkspaceLimits.MaxLinks} links.");

        var categories = new HashSet<string>(workspace.Categories!.Count, StringComparer.OrdinalIgnoreCase);
        foreach (var category in workspace.Categories!)
        {
            Text(category, WorkspaceLimits.MaxCategoryLength, "Category", required: true);
            Require(categories.Add(category), "Category names must be unique, ignoring case.");
        }
        foreach (var label in workspace.Columns!)
            Text(label, WorkspaceLimits.MaxColumnLabelLength, "Slice name", required: true);

        var tasks = new Dictionary<Guid, TaskCard>(workspace.Tasks!.Count);
        foreach (var task in workspace.Tasks!)
        {
            Require(task is not null, "The workspace contains a null task.");
            Require(task!.Id != Guid.Empty && tasks.TryAdd(task.Id, task), "A task ID is empty or duplicated.");
            Text(task.Title, WorkspaceLimits.MaxTitleLength, "Task title", required: true);
            Text(task.Description, WorkspaceLimits.MaxDescriptionLength, "Description", multiline: true);
            Text(task.Notes, WorkspaceLimits.MaxNotesLength, "Notes", multiline: true);
            Require(task.CreatedAt is null || task.CreatedAt != DateTimeOffset.MinValue, "Creation time is invalid.");
            Text(task.Category, WorkspaceLimits.MaxCategoryLength, "Task category");
            Require(task.Category.Length == 0 || categories.Contains(task.Category), "A task refers to a category that does not exist.");
            Require(Enum.IsDefined(task.State), "Task status is invalid.");
            Require(task.Column >= 0 && task.Column < workspace.Columns.Count, "The task slice is invalid.");
            Require(task.Row is >= 0 and <= WorkspaceLimits.MaxRow, "The task row is outside the allowed range.");
            Require(!task.IsArchived || task.State is TaskState.Completed or TaskState.Stopped,
                "Only completed or stopped tasks can be archived.");
            Require(task.DeletedAt is null || task.DeletedAt != DateTimeOffset.MinValue, "Deletion time is invalid.");
            if (task.ArchiveHistory is null || task.ArchiveHistory.Count > WorkspaceLimits.MaxArchiveEventsPerTask)
                throw new WorkspaceValidationException($"A task can contain at most {WorkspaceLimits.MaxArchiveEventsPerTask} archive events.");
            var archived = false;
            foreach (var entry in task.ArchiveHistory!)
            {
                Require(entry is not null && entry.At != DateTimeOffset.MinValue && Enum.IsDefined(entry.Action),
                    "An archive event is invalid.");
                Require(entry!.Action == (archived ? ArchiveAction.Unarchived : ArchiveAction.Archived),
                    "Archive history is out of sequence.");
                archived = !archived;
            }
            Require(archived == task.IsArchived, "Archive status does not match its history.");
        }

        var links = new HashSet<(Guid Source, Guid Target)>(workspace.Links!.Count);
        foreach (var link in workspace.Links!)
        {
            Require(link is not null, "The workspace contains a null link.");
            Require(tasks.TryGetValue(link!.SourceId, out var source) && tasks.TryGetValue(link.TargetId, out _),
                "A link refers to a task that does not exist.");
            var target = tasks[link.TargetId];
            Require(source!.DeletedAt is null && target.DeletedAt is null, "Trashed tasks cannot retain links.");
            // A strictly increasing column on every edge guarantees a DAG without recursion.
            Require(source.Column < target.Column, "Successors must be right of every source; links cannot form cycles.");
            Require(links.Add((link.SourceId, link.TargetId)), "The workspace contains duplicate links.");
        }
    }

    internal static void Text(string? value, int maxLength, string label, bool required = false, bool multiline = false)
    {
        if (value is null) throw new WorkspaceValidationException($"{label} cannot be null.");
        if (value.Length > maxLength) throw new WorkspaceValidationException($"{label} cannot exceed {maxLength} characters.");
        if (required && string.IsNullOrWhiteSpace(value)) throw new WorkspaceValidationException($"{label} is required.");
        foreach (var character in value)
            if (char.IsControl(character) && !(multiline && character is '\r' or '\n' or '\t'))
                throw new WorkspaceValidationException($"{label} contains unsupported control characters.");
        if (!multiline && value != value.Trim()) throw new WorkspaceValidationException($"{label} cannot have leading or trailing whitespace.");
    }

    internal static void Require(bool condition, string message)
    {
        if (!condition) throw new WorkspaceValidationException(message);
    }
}
