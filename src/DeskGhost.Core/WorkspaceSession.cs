namespace DeskGhost.Core;

/// <summary>
/// Transactional edits for a workspace. Call on one UI thread. Each successful edit
/// replaces Workspace, so an older instance can be handed to an asynchronous save.
/// Do not modify document properties directly; doing so bypasses undo and change events.
/// </summary>
public sealed class WorkspaceSession
{
    private readonly LinkedList<HistoryEntry> undo = new();
    private readonly LinkedList<HistoryEntry> redo = new();
    private long historyBytes;

    public WorkspaceSession(Workspace workspace) => Workspace = workspace.DeepClone();

    public Workspace Workspace { get; private set; }
    public long Revision { get; private set; }
    public bool CanUndo => CanTravel(undo, true);
    public bool CanRedo => CanTravel(redo, false);
    public event EventHandler? Changed;

    public TaskCard CreateTask(string title, string description, string category,
        IEnumerable<Guid>? sourceIds = null, int? column = null, int? row = null, string notes = "", TaskState state = TaskState.NotStarted)
    {
        var sources = new HashSet<Guid>();
        if (sourceIds is not null)
        {
            var count = 0;
            foreach (var sourceId in sourceIds)
            {
                WorkspaceValidator.Require(++count <= WorkspaceLimits.MaxSourcesPerCreation,
                    $"A task can be created from at most {WorkspaceLimits.MaxSourcesPerCreation} sources.");
                sources.Add(sourceId);
            }
        }

        var id = Guid.NewGuid();
        Edit(document =>
        {
            WorkspaceValidator.Require(Enum.IsDefined(state), "Task status is invalid.");
            WorkspaceValidator.Require(document.Tasks.Count < WorkspaceLimits.MaxTasks, "The task limit has been reached.");
            var minimumColumn = sources.Count == 0 ? 0 : sources.Max(sourceId => ActiveTask(document, sourceId).Column) + 1;
            var targetColumn = column ?? (sources.Count == 0 ? document.Columns.Count - 1 : minimumColumn);
            WorkspaceValidator.Require(targetColumn >= minimumColumn && targetColumn < WorkspaceLimits.MaxColumns,
                "New tasks must be right of every source and within the slice limit.");
            EnsureColumns(document, targetColumn + 1);
            var card = new TaskCard
            {
                Id = id,
                Title = title?.Trim()!,
                Description = description,
                Notes = notes,
                State = state,
                CreatedAt = DateTimeOffset.UtcNow,
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

    public void UpdateTask(Guid taskId, string title, string description, string category, string? notes = null) => Edit(document =>
    {
        var card = ActiveTask(document, taskId);
        card.Title = title?.Trim()!;
        card.Description = description;
        if (notes is not null) card.Notes = notes;
        card.Category = NormalizeCategory(document, category);
    });

    public void SetState(Guid taskId, TaskState state) => Edit(document =>
    {
        var card = ActiveTask(document, taskId);
        WorkspaceValidator.Require(Enum.IsDefined(state), "Task status is invalid.");
        WorkspaceValidator.Require(!card.IsArchived || state is TaskState.Completed or TaskState.Stopped,
            "Unarchive the task before changing its status to Not started or In progress.");
        card.State = state;
    });

    public void MoveTask(Guid taskId, int column, int row) => Edit(document =>
    {
        WorkspaceValidator.Require(column >= 0 && column <= document.Columns.Count && column < WorkspaceLimits.MaxColumns,
            "Tasks can move to an existing slice or the next adjacent slice, within the slice limit.");
        var card = ActiveTask(document, taskId);
        EnsureColumns(document, column + 1);
        card.Column = column;
        card.Row = row;
    });

    public void InsertColumn(int index, string? label = null) => Edit(document =>
    {
        WorkspaceValidator.Require(index >= 0 && index <= document.Columns.Count, "The slice insertion position is invalid.");
        WorkspaceValidator.Require(document.Columns.Count < WorkspaceLimits.MaxColumns, "The slice limit has been reached.");
        document.Columns.Insert(index, label?.Trim() ?? $"Slice {index + 1}");
        foreach (var card in document.Tasks.Where(task => task.Column >= index)) card.Column++;
    });

    public void RenameColumn(int index, string label) => Edit(document =>
    {
        WorkspaceValidator.Require(index >= 0 && index < document.Columns.Count, "The slice does not exist.");
        document.Columns[index] = label?.Trim()!;
    });

    public void RenameWorkspace(string name) => Edit(document => document.Name = name?.Trim()!);

    public void AddCategory(string category) => Edit(document =>
    {
        WorkspaceValidator.Text(category?.Trim(), WorkspaceLimits.MaxCategoryLength, "Category", required: true);
        NormalizeCategory(document, category);
    });

    public void AddLink(Guid sourceId, Guid targetId) => Edit(document =>
    {
        var source = ActiveTask(document, sourceId);
        var target = ActiveTask(document, targetId);
        WorkspaceValidator.Require(source.Column < target.Column, "Successor tasks must be right of their source.");
        if (!document.Links.Any(link => link.SourceId == sourceId && link.TargetId == targetId))
            document.Links.Add(new TaskLink { SourceId = sourceId, TargetId = targetId });
    });

    /// <summary>Connects an existing task, shifting it and affected successors right in one transaction.</summary>
    public void ConnectTask(Guid sourceId, Guid targetId) => Edit(document =>
    {
        var source = ActiveTask(document, sourceId);
        var target = ActiveTask(document, targetId);
        WorkspaceValidator.Require(sourceId != targetId, "A task cannot link to itself.");
        if (document.Links.Any(link => link.SourceId == sourceId && link.TargetId == targetId)) return;
        var outgoing = document.Links.ToLookup(link => link.SourceId, link => link.TargetId);
        var visited = new HashSet<Guid>();
        var pending = new Stack<Guid>();
        pending.Push(targetId);
        while (pending.TryPop(out var current))
        {
            WorkspaceValidator.Require(current != sourceId, "This link would create a cycle.");
            if (!visited.Add(current)) continue;
            foreach (var next in outgoing[current]) pending.Push(next);
        }

        var columns = document.Tasks.ToDictionary(task => task.Id, task => task.Column);
        columns[targetId] = Math.Max(target.Column, source.Column + 1);
        // Existing columns are already a topological order. Propagate only the
        // minimum shifts needed to keep every existing edge pointing right.
        foreach (var task in document.Tasks.OrderBy(task => task.Column))
        {
            WorkspaceValidator.Require(columns[task.Id] < WorkspaceLimits.MaxColumns, "This connection would exceed the slice limit.");
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
            "The original link no longer exists. Select it again.");
        var source = ActiveTask(document, newSourceId);
        var target = ActiveTask(document, newTargetId);
        WorkspaceValidator.Require(source.Column < target.Column, "Successor tasks must be right of their source.");
        if (sourceId == newSourceId && targetId == newTargetId) return;
        WorkspaceValidator.Require(!document.Links.Any(link => link.SourceId == newSourceId && link.TargetId == newTargetId),
            "These tasks are already linked.");
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
        WorkspaceValidator.Require(card.State is TaskState.Completed or TaskState.Stopped, "Only completed or stopped tasks can be archived.");
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

    /// <summary>Prepares a single-card move; callers can persist both candidates before committing.</summary>
    public WorkspaceChange PrepareTransferTo(WorkspaceSession target, Guid taskId)
    {
        WorkspaceValidator.Require(!ReferenceEquals(this, target) && Workspace.Id != target.Workspace.Id,
            "Choose a different target workspace.");
        var sourceBytes = WorkspaceJson.Serialize(Workspace);
        var targetBytes = WorkspaceJson.Serialize(target.Workspace);
        var sourceAfter = WorkspaceJson.Deserialize(sourceBytes);
        var targetAfter = WorkspaceJson.Deserialize(targetBytes);
        var card = ActiveTask(sourceAfter, taskId);
        WorkspaceValidator.Require(!targetAfter.Tasks.Any(task => task.Id == taskId),
            "The target workspace already contains this task ID. No card was moved.");
        WorkspaceValidator.Require(targetAfter.Tasks.Count < WorkspaceLimits.MaxTasks,
            "The target workspace has reached its task limit.");
        card.Category = NormalizeCategory(targetAfter, card.Category);
        card.Column = targetAfter.Columns.Count - 1;
        card.Row = FindFreeRow(targetAfter, card.Column);
        targetAfter.Tasks.Add(card);
        sourceAfter.Tasks.Remove(card);
        sourceAfter.Links.RemoveAll(link => link.SourceId == taskId || link.TargetId == taskId);
        WorkspaceJson.Serialize(sourceAfter);
        WorkspaceJson.Serialize(targetAfter);
        var pair = new PairedHistory(this, target);
        // The receiving file must become durable before the removing file.
        return new WorkspaceChange([
            target.PrepareStep(targetAfter, () => target.RecordEdit(targetBytes, pair)),
            PrepareStep(sourceAfter, () => RecordEdit(sourceBytes, pair))
        ]);
    }

    public WorkspaceChange? PrepareUndo() => PrepareTravel(undo, redo, true);
    public WorkspaceChange? PrepareRedo() => PrepareTravel(redo, undo, false);
    public bool Undo() { var change = PrepareUndo(); change?.Commit(); return change is not null; }
    public bool Redo() { var change = PrepareRedo(); change?.Commit(); return change is not null; }

    /// <summary>Closing a document invalidates shared history instead of permitting a one-sided undo.</summary>
    public void DiscardHistory()
    {
        foreach (var entry in undo.Concat(redo)) entry.Pair?.Invalidate();
        undo.Clear(); redo.Clear(); historyBytes = 0;
    }

    private void Edit(Action<Workspace> edit)
    {
        var before = WorkspaceJson.Serialize(Workspace);
        var candidate = WorkspaceJson.Deserialize(before);
        edit(candidate);
        var after = WorkspaceJson.Serialize(candidate);
        if (before.AsSpan().SequenceEqual(after)) return;

        RecordEdit(before);
        Workspace = candidate;
        Revision++;
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private void RecordEdit(byte[] before, PairedHistory? pair = null)
    {
        foreach (var entry in redo) { historyBytes -= entry.Snapshot.Length; entry.Pair?.Invalidate(); }
        redo.Clear();
        undo.AddLast(new HistoryEntry(before, pair));
        historyBytes += before.Length;
        TrimHistory();
    }

    private bool CanTravel(LinkedList<HistoryEntry> from, bool backwards)
    {
        var entry = from.Last?.Value;
        return entry is not null && (entry.Pair is null || entry.Pair.TryOther(this, out var other) &&
            ReferenceEquals((backwards ? other!.undo : other!.redo).Last?.Value.Pair, entry.Pair));
    }

    private WorkspaceChange? PrepareTravel(LinkedList<HistoryEntry> from, LinkedList<HistoryEntry> to, bool backwards)
    {
        var entry = from.Last?.Value;
        if (entry is null) return null;
        WorkspaceValidator.Require(CanTravel(from, backwards),
            "This move belongs to two workspaces. Keep both open and undo their later changes first. If either history was closed or discarded, this boundary cannot be crossed.");
        var steps = new List<WorkspaceChangeStep>();
        WorkspaceChangeStep TravelStep(WorkspaceSession session, LinkedList<HistoryEntry> origin, LinkedList<HistoryEntry> destination)
        {
            var previous = origin.Last!.Value;
            var current = WorkspaceJson.Serialize(session.Workspace);
            return session.PrepareStep(WorkspaceJson.Deserialize(previous.Snapshot), () =>
            {
                session.historyBytes -= previous.Snapshot.Length;
                origin.RemoveLast();
                destination.AddLast(new HistoryEntry(current, previous.Pair));
                session.historyBytes += current.Length;
                session.TrimHistory();
            }, () => ReferenceEquals(origin.Last?.Value, previous) && session.CanTravel(origin, backwards));
        }
        if (entry.Pair is { } pair)
        {
            pair.TryOther(this, out var other);
            steps.Add(TravelStep(other!, backwards ? other!.undo : other!.redo, backwards ? other!.redo : other!.undo));
        }
        steps.Add(TravelStep(this, from, to));
        // Undo receives into the original source; redo receives into the target.
        // Sorting by task-count growth also handles invocation from either side.
        return new WorkspaceChange(steps.OrderByDescending(step => step.After.Tasks.Count - step.Before.Tasks.Count).ToArray());
    }

    private WorkspaceChangeStep PrepareStep(Workspace candidate, Action history, Func<bool>? historyUnchanged = null)
    {
        var revision = Revision;
        var before = Workspace;
        return new WorkspaceChangeStep(this, before, candidate,
            () => Revision == revision && ReferenceEquals(Workspace, before) && (historyUnchanged?.Invoke() ?? true),
            () => { history(); Workspace = candidate; Revision++; },
            () => Changed?.Invoke(this, EventArgs.Empty));
    }

    private void TrimHistory()
    {
        while (undo.Count + redo.Count > WorkspaceLimits.MaxHistoryEntries || historyBytes > WorkspaceLimits.MaxHistoryBytes)
        {
            var oldest = undo.Count > 0 ? undo : redo;
            historyBytes -= oldest.First!.Value.Snapshot.Length;
            oldest.First.Value.Pair?.Invalidate();
            oldest.RemoveFirst();
        }
    }

    private sealed record HistoryEntry(byte[] Snapshot, PairedHistory? Pair = null);

    private sealed class PairedHistory(WorkspaceSession source, WorkspaceSession target)
    {
        private readonly WeakReference<WorkspaceSession> first = new(source), second = new(target);
        private bool invalidated;
        public void Invalidate() => invalidated = true;
        public bool TryOther(WorkspaceSession session, out WorkspaceSession? other)
        {
            other = null;
            if (invalidated || !first.TryGetTarget(out var a) || !second.TryGetTarget(out var b)) return false;
            other = ReferenceEquals(session, a) ? b : ReferenceEquals(session, b) ? a : null;
            return other is not null;
        }
    }

    private static TaskCard FindTask(Workspace document, Guid id) => document.Tasks.FirstOrDefault(task => task.Id == id)
        ?? throw new WorkspaceValidationException("The task does not exist.");

    private static TaskCard ActiveTask(Workspace document, Guid id)
    {
        var card = FindTask(document, id);
        WorkspaceValidator.Require(card.DeletedAt is null, "Restore the task from trash first.");
        return card;
    }

    private static string NormalizeCategory(Workspace document, string? category)
    {
        var normalized = category?.Trim();
        WorkspaceValidator.Text(normalized, WorkspaceLimits.MaxCategoryLength, "Category");
        if (normalized!.Length == 0) return "";
        var existing = document.Categories.FirstOrDefault(value => value.Equals(normalized, StringComparison.OrdinalIgnoreCase));
        if (existing is not null) return existing;
        WorkspaceValidator.Require(document.Categories.Count < WorkspaceLimits.MaxCategories, "The category limit has been reached.");
        document.Categories.Add(normalized);
        return normalized;
    }

    private static void EnsureColumns(Workspace document, int count)
    {
        while (document.Columns.Count < count) document.Columns.Add($"Slice {document.Columns.Count + 1}");
    }

    private static int FindFreeRow(Workspace document, int column)
    {
        var occupied = document.Tasks.Where(task => task.Column == column && task.DeletedAt is null)
            .Select(task => task.Row).ToHashSet();
        for (var row = 0; row <= WorkspaceLimits.MaxRow; row++)
            if (!occupied.Contains(row)) return row;
        throw new WorkspaceValidationException("This slice has no free positions.");
    }
}

/// <summary>A validated change whose ordered snapshots can be saved before publishing new session history.</summary>
public sealed class WorkspaceChange
{
    public IReadOnlyList<WorkspaceChangeStep> Steps { get; }
    private bool committed;
    internal WorkspaceChange(WorkspaceChangeStep[] steps) => Steps = Array.AsReadOnly(steps);
    public void Commit()
    {
        WorkspaceValidator.Require(!committed && Steps.All(step => step.Unchanged()),
            "The workspaces changed while this operation was pending. Retry the operation.");
        foreach (var step in Steps) step.Apply();
        committed = true;
        foreach (var step in Steps) step.Notify();
    }
}

public sealed class WorkspaceChangeStep
{
    public WorkspaceSession Session { get; }
    public Workspace Before { get; }
    public Workspace After { get; }
    internal Func<bool> Unchanged { get; }
    internal Action Apply { get; }
    internal Action Notify { get; }
    internal WorkspaceChangeStep(WorkspaceSession session, Workspace before, Workspace after,
        Func<bool> unchanged, Action apply, Action notify) =>
        (Session, Before, After, Unchanged, Apply, Notify) = (session, before, after, unchanged, apply, notify);
}
