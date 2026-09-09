namespace DeskGhost.Core;

public static class WorkspaceValidator
{
    public static void Validate(Workspace workspace)
    {
        Require(workspace is not null, "工作区数据不能为空。");
        Require(workspace!.FormatVersion == WorkspaceLimits.CurrentFormatVersion,
            $"不支持工作区格式版本 {workspace.FormatVersion}，请使用兼容版本打开。");
        Require(workspace.Id != Guid.Empty, "工作区标识无效。");
        Text(workspace.Name, WorkspaceLimits.MaxNameLength, "工作区名称", required: true);
        Require(workspace.Categories is not null && workspace.Categories.Count <= WorkspaceLimits.MaxCategories,
            $"分类数量不能超过 {WorkspaceLimits.MaxCategories}。");
        Require(workspace.Columns is not null && workspace.Columns.Count is > 0 and <= WorkspaceLimits.MaxColumns,
            $"逻辑时间列数量必须在 1 到 {WorkspaceLimits.MaxColumns} 之间。");
        Require(workspace.Tasks is not null && workspace.Tasks.Count <= WorkspaceLimits.MaxTasks,
            $"任务数量（含归档及回收站）不能超过 {WorkspaceLimits.MaxTasks}。");
        Require(workspace.Links is not null && workspace.Links.Count <= WorkspaceLimits.MaxLinks,
            $"连线数量不能超过 {WorkspaceLimits.MaxLinks}。");

        var categories = new HashSet<string>(workspace.Categories!.Count, StringComparer.OrdinalIgnoreCase);
        foreach (var category in workspace.Categories!)
        {
            Text(category, WorkspaceLimits.MaxCategoryLength, "分类", required: true);
            Require(categories.Add(category), "分类名称不能重复（不区分大小写）。");
        }
        foreach (var label in workspace.Columns!)
            Text(label, WorkspaceLimits.MaxColumnLabelLength, "时间列名称", required: true);

        var tasks = new Dictionary<Guid, TaskCard>(workspace.Tasks!.Count);
        foreach (var task in workspace.Tasks!)
        {
            Require(task is not null, "工作区含有空任务。");
            Require(task!.Id != Guid.Empty && tasks.TryAdd(task.Id, task), "任务标识为空或重复。");
            Text(task.Title, WorkspaceLimits.MaxTitleLength, "任务标题", required: true);
            Text(task.Description, WorkspaceLimits.MaxDescriptionLength, "任务内容", multiline: true);
            Text(task.Category, WorkspaceLimits.MaxCategoryLength, "任务分类");
            Require(task.Category.Length == 0 || categories.Contains(task.Category), "任务引用了不存在的分类。");
            Require(Enum.IsDefined(task.State), "任务状态无效。");
            Require(task.Column >= 0 && task.Column < workspace.Columns.Count, "任务所在时间列无效。");
            Require(task.Row is >= 0 and <= WorkspaceLimits.MaxRow, "任务纵向位置超出允许范围。");
            Require(!task.IsArchived || task.State is TaskState.Completed or TaskState.Stopped,
                "只有已完成或已停止的任务可以归档。");
            Require(task.DeletedAt is null || task.DeletedAt != DateTimeOffset.MinValue, "删除时间无效。");
            if (task.ArchiveHistory is null || task.ArchiveHistory.Count > WorkspaceLimits.MaxArchiveEventsPerTask)
                throw new WorkspaceValidationException($"单个任务的归档历史不能超过 {WorkspaceLimits.MaxArchiveEventsPerTask} 条。");
            var archived = false;
            foreach (var entry in task.ArchiveHistory!)
            {
                Require(entry is not null && entry.At != DateTimeOffset.MinValue && Enum.IsDefined(entry.Action),
                    "归档历史记录无效。");
                Require(entry!.Action == (archived ? ArchiveAction.Unarchived : ArchiveAction.Archived),
                    "归档历史顺序无效。");
                archived = !archived;
            }
            Require(archived == task.IsArchived, "归档状态与历史记录不一致。");
        }

        var links = new HashSet<(Guid Source, Guid Target)>(workspace.Links!.Count);
        foreach (var link in workspace.Links!)
        {
            Require(link is not null, "工作区含有空连线。");
            Require(tasks.TryGetValue(link!.SourceId, out var source) && tasks.TryGetValue(link.TargetId, out _),
                "连线引用了不存在的任务。");
            var target = tasks[link.TargetId];
            Require(source!.DeletedAt is null && target.DeletedAt is null, "回收站任务不能保留连线。");
            // A strictly increasing column on every edge guarantees a DAG without recursion.
            Require(source.Column < target.Column, "后续任务必须位于所有来源任务的右侧，连线不能形成循环。");
            Require(links.Add((link.SourceId, link.TargetId)), "工作区含有重复连线。");
        }
    }

    internal static void Text(string? value, int maxLength, string label, bool required = false, bool multiline = false)
    {
        if (value is null) throw new WorkspaceValidationException($"{label}不能为空值。");
        if (value.Length > maxLength) throw new WorkspaceValidationException($"{label}不能超过 {maxLength} 个字符。");
        if (required && string.IsNullOrWhiteSpace(value)) throw new WorkspaceValidationException($"请填写{label}。");
        foreach (var character in value)
            if (char.IsControl(character) && !(multiline && character is '\r' or '\n' or '\t'))
                throw new WorkspaceValidationException($"{label}包含不支持的控制字符。");
        if (!multiline && value != value.Trim()) throw new WorkspaceValidationException($"{label}首尾不能含有空白字符。");
    }

    internal static void Require(bool condition, string message)
    {
        if (!condition) throw new WorkspaceValidationException(message);
    }
}
