namespace DeskGhost.Core;

/// <summary>
/// Transactional edits for a workspace. Call on one UI thread. Each successful edit
/// replaces Workspace, so an older instance can be handed to an asynchronous save.
/// Do not modify document properties directly; doing so bypasses undo and change events.
/// </summary>
public sealed class WorkspaceSession
{
    private readonly LinkedList<byte[]> undo = new();
    private readonly LinkedList<byte[]> redo = new();
    private long historyBytes;

    public WorkspaceSession(Workspace workspace) => Workspace = workspace.DeepClone();

    public Workspace Workspace { get; private set; }
    public long Revision { get; private set; }
    public bool CanUndo => undo.Count > 0;
    public bool CanRedo => redo.Count > 0;
    public event EventHandler? Changed;

    public TaskCard CreateTask(string title, string description, string category,
        IEnumerable<Guid>? sourceIds = null, int? column = null, int? row = null)
    {
        var sources = new HashSet<Guid>();
        if (sourceIds is not null)
        {
            var count = 0;
            foreach (var sourceId in sourceIds)
            {
                WorkspaceValidator.Require(++count <= WorkspaceLimits.MaxSourcesPerCreation,
                    $"一次创建最多接受 {WorkspaceLimits.MaxSourcesPerCreation} 个来源。");
                sources.Add(sourceId);
            }
        }

        var id = Guid.NewGuid();
        Edit(document =>
        {
            WorkspaceValidator.Require(document.Tasks.Count < WorkspaceLimits.MaxTasks, "任务数量已达上限。");
            var minimumColumn = sources.Count == 0 ? 0 : sources.Max(sourceId => ActiveTask(document, sourceId).Column) + 1;
            var targetColumn = column ?? (sources.Count == 0 ? document.Columns.Count - 1 : minimumColumn);
            WorkspaceValidator.Require(targetColumn >= minimumColumn && targetColumn < WorkspaceLimits.MaxColumns,
                "新任务必须在全部来源的右侧，且不能超过时间列上限。");
            EnsureColumns(document, targetColumn + 1);
            var card = new TaskCard
            {
                Id = id,
                Title = title?.Trim()!,
                Description = description,
                Category = NormalizeCategory(document, category),
                Column = targetColumn,
                Row = row ?? FindFreeRow(document, targetColumn)
            };
            document.Tasks.Add(card);
            foreach (var sourceId in sources)
                document.Links.Add(new TaskLink { SourceId = sourceId, TargetId = id });
        });
        return Workspace.Tasks.Single(task => task.Id == id);
    }

    public void UpdateTask(Guid taskId, string title, string description, string category) => Edit(document =>
    {
        var card = ActiveTask(document, taskId);
        card.Title = title?.Trim()!;
        card.Description = description;
        card.Category = NormalizeCategory(document, category);
    });

    public void SetState(Guid taskId, TaskState state) => Edit(document =>
    {
        var card = ActiveTask(document, taskId);
        WorkspaceValidator.Require(Enum.IsDefined(state), "任务状态无效。");
        WorkspaceValidator.Require(!card.IsArchived || state is TaskState.Completed or TaskState.Stopped,
            "请先恢复归档任务，再改为未开始或进行中。");
        card.State = state;
    });

    public void MoveTask(Guid taskId, int column, int row) => Edit(document =>
    {
        WorkspaceValidator.Require(column >= 0 && column <= document.Columns.Count && column < WorkspaceLimits.MaxColumns,
            "只能移动到现有时间列或紧邻的下一列，且不能超过时间列上限。");
        var card = ActiveTask(document, taskId);
        EnsureColumns(document, column + 1);
        card.Column = column;
        card.Row = row;
    });

    public void InsertColumn(int index, string? label = null) => Edit(document =>
    {
        WorkspaceValidator.Require(index >= 0 && index <= document.Columns.Count, "插入时间列的位置无效。");
        WorkspaceValidator.Require(document.Columns.Count < WorkspaceLimits.MaxColumns, "时间列数量已达上限。");
        document.Columns.Insert(index, label?.Trim() ?? $"阶段 {index + 1}");
        foreach (var card in document.Tasks.Where(task => task.Column >= index)) card.Column++;
    });

    public void RenameColumn(int index, string label) => Edit(document =>
    {
        WorkspaceValidator.Require(index >= 0 && index < document.Columns.Count, "时间列不存在。");
        document.Columns[index] = label?.Trim()!;
    });

    public void RenameWorkspace(string name) => Edit(document => document.Name = name?.Trim()!);

    public void AddCategory(string category) => Edit(document =>
    {
        WorkspaceValidator.Text(category?.Trim(), WorkspaceLimits.MaxCategoryLength, "分类", required: true);
        NormalizeCategory(document, category);
    });

    public void AddLink(Guid sourceId, Guid targetId) => Edit(document =>
    {
        var source = ActiveTask(document, sourceId);
        var target = ActiveTask(document, targetId);
        WorkspaceValidator.Require(source.Column < target.Column, "后续任务必须位于来源任务的右侧。");
        if (!document.Links.Any(link => link.SourceId == sourceId && link.TargetId == targetId))
            document.Links.Add(new TaskLink { SourceId = sourceId, TargetId = targetId });
    });

    /// <summary>Connects an existing task, shifting it and affected successors right in one transaction.</summary>
    public void ConnectTask(Guid sourceId, Guid targetId) => Edit(document =>
    {
        var source = ActiveTask(document, sourceId);
        var target = ActiveTask(document, targetId);
        WorkspaceValidator.Require(sourceId != targetId, "任务不能连接到自身。");
        if (document.Links.Any(link => link.SourceId == sourceId && link.TargetId == targetId)) return;
        var outgoing = document.Links.ToLookup(link => link.SourceId, link => link.TargetId);
        var visited = new HashSet<Guid>();
        var pending = new Stack<Guid>();
        pending.Push(targetId);
        while (pending.TryPop(out var current))
        {
            WorkspaceValidator.Require(current != sourceId, "这条连线会形成循环。");
            if (!visited.Add(current)) continue;
            foreach (var next in outgoing[current]) pending.Push(next);
        }

        var columns = document.Tasks.ToDictionary(task => task.Id, task => task.Column);
        columns[targetId] = Math.Max(target.Column, source.Column + 1);
        // Existing columns are already a topological order. Propagate only the
        // minimum shifts needed to keep every existing edge pointing right.
        foreach (var task in document.Tasks.OrderBy(task => task.Column))
        {
            WorkspaceValidator.Require(columns[task.Id] < WorkspaceLimits.MaxColumns, "连接后将超过时间列上限。");
            foreach (var next in outgoing[task.Id]) columns[next] = Math.Max(columns[next], columns[task.Id] + 1);
        }
        foreach (var task in document.Tasks)
        {
            var column = columns[task.Id];
            if (column == task.Column) continue;
            if (document.Tasks.Any(other => other.Id != task.Id && other.DeletedAt is null && other.Column == column && other.Row == task.Row))
                task.Row = FindFreeRow(document, column);
            task.Column = column;
        }
        EnsureColumns(document, columns.Values.Max() + 1);
        document.Links.Add(new TaskLink { SourceId = sourceId, TargetId = targetId });
    });

    public void RemoveLink(Guid sourceId, Guid targetId) => Edit(document =>
    {
        document.Links.RemoveAll(link => link.SourceId == sourceId && link.TargetId == targetId);
    });

    /// <summary>Retargets a dragged edge as one validated, undoable transaction.</summary>
    public void RewireLink(Guid sourceId, Guid targetId, Guid newSourceId, Guid newTargetId) => Edit(document =>
    {
        WorkspaceValidator.Require(document.Links.Any(link => link.SourceId == sourceId && link.TargetId == targetId),
            "原连线不存在，请重新选择。");
        var source = ActiveTask(document, newSourceId);
        var target = ActiveTask(document, newTargetId);
        WorkspaceValidator.Require(source.Column < target.Column, "后续任务必须位于来源任务的右侧。");
        if (sourceId == newSourceId && targetId == newTargetId) return;
        WorkspaceValidator.Require(!document.Links.Any(link => link.SourceId == newSourceId && link.TargetId == newTargetId),
            "这两个任务之间已有连线。");
        document.Links.RemoveAll(link => link.SourceId == sourceId && link.TargetId == targetId);
        document.Links.Add(new TaskLink { SourceId = newSourceId, TargetId = newTargetId });
    });

    /// <summary>Moves only this card to trash and removes its incident edges. Undo restores both.</summary>
    public void DeleteTask(Guid taskId) => Edit(document =>
    {
        var card = ActiveTask(document, taskId);
        card.DeletedAt = DateTimeOffset.UtcNow;
        document.Links.RemoveAll(link => link.SourceId == taskId || link.TargetId == taskId);
    });

    /// <summary>Restores the card from trash without restoring or inventing edges.</summary>
    public void RestoreTask(Guid taskId) => Edit(document => FindTask(document, taskId).DeletedAt = null);

    public void ArchiveTask(Guid taskId) => Edit(document =>
    {
        var card = ActiveTask(document, taskId);
        WorkspaceValidator.Require(card.State is TaskState.Completed or TaskState.Stopped, "只有已完成或已停止的任务可以归档。");
        if (card.IsArchived) return;
        card.IsArchived = true;
        card.ArchiveHistory.Add(new ArchiveEvent { At = DateTimeOffset.UtcNow, Action = ArchiveAction.Archived });
    });

    public void UnarchiveTask(Guid taskId) => Edit(document =>
    {
        var card = ActiveTask(document, taskId);
        if (!card.IsArchived) return;
        card.IsArchived = false;
        card.ArchiveHistory.Add(new ArchiveEvent { At = DateTimeOffset.UtcNow, Action = ArchiveAction.Unarchived });
    });

    public bool Undo() => Travel(undo, redo);
    public bool Redo() => Travel(redo, undo);

    private void Edit(Action<Workspace> edit)
    {
        var before = WorkspaceJson.Serialize(Workspace);
        var candidate = WorkspaceJson.Deserialize(before);
        edit(candidate);
        var after = WorkspaceJson.Serialize(candidate);
        if (before.AsSpan().SequenceEqual(after)) return;

        foreach (var snapshot in redo) historyBytes -= snapshot.Length;
        redo.Clear();
        undo.AddLast(before);
        historyBytes += before.Length;
        TrimHistory();
        Workspace = candidate;
        Revision++;
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private bool Travel(LinkedList<byte[]> from, LinkedList<byte[]> to)
    {
        if (from.Last is null) return false;
        var candidate = WorkspaceJson.Deserialize(from.Last.Value);
        var current = WorkspaceJson.Serialize(Workspace);
        historyBytes -= from.Last.Value.Length;
        from.RemoveLast();
        to.AddLast(current);
        historyBytes += current.Length;
        TrimHistory();
        Workspace = candidate;
        Revision++;
        Changed?.Invoke(this, EventArgs.Empty);
        return true;
    }

    private void TrimHistory()
    {
        while (undo.Count + redo.Count > WorkspaceLimits.MaxHistoryEntries || historyBytes > WorkspaceLimits.MaxHistoryBytes)
        {
            var oldest = undo.Count > 0 ? undo : redo;
            historyBytes -= oldest.First!.Value.Length;
            oldest.RemoveFirst();
        }
    }

    private static TaskCard FindTask(Workspace document, Guid id) => document.Tasks.FirstOrDefault(task => task.Id == id)
        ?? throw new WorkspaceValidationException("任务不存在。");

    private static TaskCard ActiveTask(Workspace document, Guid id)
    {
        var card = FindTask(document, id);
        WorkspaceValidator.Require(card.DeletedAt is null, "请先从回收站恢复任务。");
        return card;
    }

    private static string NormalizeCategory(Workspace document, string? category)
    {
        var normalized = category?.Trim();
        WorkspaceValidator.Text(normalized, WorkspaceLimits.MaxCategoryLength, "分类");
        if (normalized!.Length == 0) return "";
        var existing = document.Categories.FirstOrDefault(value => value.Equals(normalized, StringComparison.OrdinalIgnoreCase));
        if (existing is not null) return existing;
        WorkspaceValidator.Require(document.Categories.Count < WorkspaceLimits.MaxCategories, "分类数量已达上限。");
        document.Categories.Add(normalized);
        return normalized;
    }

    private static void EnsureColumns(Workspace document, int count)
    {
        while (document.Columns.Count < count) document.Columns.Add($"阶段 {document.Columns.Count + 1}");
    }

    private static int FindFreeRow(Workspace document, int column)
    {
        var occupied = document.Tasks.Where(task => task.Column == column && task.DeletedAt is null)
            .Select(task => task.Row).ToHashSet();
        for (var row = 0; row <= WorkspaceLimits.MaxRow; row++)
            if (!occupied.Contains(row)) return row;
        throw new WorkspaceValidationException("此时间列已没有可用位置。");
    }
}
