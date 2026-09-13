using System.Text.Json;
using System.Text.Json.Nodes;
using DeskGhost.Core;

if (args.Contains("--benchmark", StringComparer.Ordinal))
{
    Benchmark();
    return 0;
}

var checks = new (string Name, Func<Task> Run)[]
{
    ("Branching, merging and forward-only links", Sync(GraphRules)),
    ("New task placement in the latest stage", Sync(CreationPlacement)),
    ("Task notes, creation time and transactional metadata", Sync(Metadata)),
    ("Cross-workspace transfer and paired history safety", Sync(Transfer)),
    ("Task lifecycle, deletion and history", Sync(Lifecycle)),
    ("Transactional edits and undo/redo", Sync(History)),
    ("Malformed workspaces and processing limits", Sync(Validation)),
    ("Atomic persistence, concurrent writes and explicit recovery", Storage)
};
var failed = 0;
foreach (var (name, run) in checks)
{
    try
    {
        await run();
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception error)
    {
        failed++;
        Console.Error.WriteLine($"FAIL {name}: {error}");
    }
}
Console.WriteLine($"{checks.Length - failed}/{checks.Length} checks passed.");
return failed == 0 ? 0 : 1;

static Func<Task> Sync(Action action) => () =>
{
    action();
    return Task.CompletedTask;
};

static void Benchmark()
{
    var workspace = Workspace.CreateNew("Performance check");
    workspace.Columns = Enumerable.Range(1, 20).Select(i => $"Stage {i}").ToList();
    var description = new string('x', 4_000);
    for (var i = 0; i < WorkspaceLimits.MaxTasks; i++)
        workspace.Tasks.Add(new TaskCard { Title = $"Task {i}", Description = description, Column = i / 100, Row = i % 100 });
    WorkspaceValidator.Validate(workspace);
    var session = new WorkspaceSession(workspace);
    var taskId = session.Workspace.Tasks[0].Id;
    var revision = 0;
    session.UpdateTask(taskId, $"Edit {revision++}", description, "");
    Measure("Validate 2,000 tasks x 4,000 description characters", () => WorkspaceValidator.Validate(workspace));
    Measure("Transactional edit of the same workspace", () => session.UpdateTask(taskId, $"Edit {revision++}", description, ""));
    using var process = System.Diagnostics.Process.GetCurrentProcess();
    process.Refresh();
    Console.WriteLine($"Peak process working set: {process.PeakWorkingSet64 / 1048576d:F1} MiB");
    Console.WriteLine("Diagnostic only: timings are not pass/fail thresholds and do not represent desktop idle usage.");

    static void Measure(string name, Action action)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        var allocated = GC.GetAllocatedBytesForCurrentThread();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        const int iterations = 3;
        for (var i = 0; i < iterations; i++) action();
        clock.Stop();
        Console.WriteLine($"{name}: {clock.Elapsed.TotalMilliseconds / iterations:F1} ms/op; " +
            $"{(GC.GetAllocatedBytesForCurrentThread() - allocated) / (1048576d * iterations):F2} MiB allocated/op");
    }
}

static WorkspaceSession NewSession() => new(Workspace.CreateNew("验证工作区"));

static void Transfer()
{
    var source = NewSession();
    var first = source.CreateTask("First", "Keep source", "");
    var card = source.CreateTask("Moving card", "Keep description", "Research", [first.Id], notes: "Long notes\nKeep these too");
    var last = source.CreateTask("Last", "Keep successor", "", [card.Id]);
    source.AddLink(first.Id, last.Id);
    source.SetState(card.Id, TaskState.Completed);
    source.ArchiveTask(card.Id);
    source.UnarchiveTask(card.Id);
    source.ArchiveTask(card.Id);
    var original = source.Workspace.Tasks.Single(task => task.Id == card.Id);
    var target = NewSession();
    target.InsertColumn(1); target.InsertColumn(2);
    target.CreateTask("Occupied row", "", "", column: 2, row: 0);
    var sourceBefore = JsonSerializer.Serialize(source.Workspace);
    var targetBefore = JsonSerializer.Serialize(target.Workspace);
    var beforeRevision = source.Revision;
    var prepared = source.PrepareTransferTo(target, card.Id);
    Check(JsonSerializer.Serialize(source.Workspace) == sourceBefore && JsonSerializer.Serialize(target.Workspace) == targetBefore && source.Revision == beforeRevision,
        "Preparing a move must not change either session or its undo history.");
    Check(ReferenceEquals(prepared.Steps[0].Session, target) && prepared.Steps[0].After.Tasks.Any(task => task.Id == card.Id),
        "The receiving copy must be saved before the removing workspace.");
    prepared.Commit();
    var moved = target.Workspace.Tasks.Single(task => task.Id == card.Id);
    Check(moved.Title == original.Title && moved.Description == original.Description && moved.Notes == original.Notes &&
          moved.CreatedAt == original.CreatedAt && moved.State == original.State && moved.IsArchived == original.IsArchived &&
          JsonSerializer.Serialize(moved.ArchiveHistory) == JsonSerializer.Serialize(original.ArchiveHistory),
        "A move must preserve identity, content, timestamps, status and complete archive history.");
    Check(moved.Column == 2 && moved.Row == 1 && target.Workspace.Categories.Contains("Research"),
        "A moved card must use the target's rightmost slice, a free row and its category.");
    Check(source.Workspace.Tasks.Count == 2 && source.Workspace.Tasks.All(task => task.Id != card.Id) &&
          source.Workspace.Links.Count == 1 && source.Workspace.Links[0].SourceId == first.Id && source.Workspace.Links[0].TargetId == last.Id,
        "Only the moved card and its incident links are removed; other tasks and links remain.");
    var sourceAfter = JsonSerializer.Serialize(source.Workspace);
    var targetAfter = JsonSerializer.Serialize(target.Workspace);
    var undoPlan = target.PrepareUndo()!;
    Check(ReferenceEquals(undoPlan.Steps[0].Session, source), "Undo must first durably restore the source card.");
    undoPlan.Commit();
    Check(JsonSerializer.Serialize(source.Workspace) == sourceBefore && JsonSerializer.Serialize(target.Workspace) == targetBefore,
        "Undo from either workspace must restore both exact snapshots, including original links and placement.");
    Check(source.Redo() && JsonSerializer.Serialize(source.Workspace) == sourceAfter && JsonSerializer.Serialize(target.Workspace) == targetAfter,
        "Redo from the source must repeat the complete two-workspace move.");
    target.UpdateTask(card.Id, "Later edit", moved.Description, moved.Category, "Later notes");
    Check(!source.CanUndo, "One side cannot undo a shared move while its partner has newer edits.");
    Reject<WorkspaceValidationException>(() => source.Undo());
    Check(target.Undo() && source.CanUndo && source.Undo(), "Undoing the later edit must make the paired move undoable again.");
    Check(target.Redo(), "The other workspace may redo the paired move.");
    source.DiscardHistory();
    Check(!target.CanUndo, "Closing one side must invalidate the shared undo boundary.");
    Reject<WorkspaceValidationException>(() => target.Undo());
    Check(target.Workspace.Tasks.Any(task => task.Id == card.Id), "A closed partner cannot cause a one-sided card deletion.");

    var branchSource = NewSession();
    var branchCard = branchSource.CreateTask("Branch", "", "");
    var branchTarget = NewSession();
    branchSource.PrepareTransferTo(branchTarget, branchCard.Id).Commit();
    branchTarget.Undo();
    branchSource.UpdateTask(branchCard.Id, "Keep the new branch", "", "");
    Check(!branchTarget.CanRedo, "A new edit on either side invalidates the other side's paired redo.");
    Reject<WorkspaceValidationException>(() => branchTarget.Redo());

    var trimSource = NewSession();
    var trimCard = trimSource.CreateTask("History boundary", "", "");
    var trimTarget = NewSession();
    trimSource.PrepareTransferTo(trimTarget, trimCard.Id).Commit();
    for (var i = 0; i <= WorkspaceLimits.MaxHistoryEntries; i++) trimTarget.RenameWorkspace($"Later {i}");
    Check(!trimSource.CanUndo, "Evicting one side of a paired history must invalidate its partner.");
    Reject<WorkspaceValidationException>(() => trimSource.Undo());

    var validationSource = NewSession();
    var validationCard = validationSource.CreateTask("Unique ID", "", "New category");
    var validationBefore = JsonSerializer.Serialize(validationSource.Workspace);
    var duplicateWorkspace = Workspace.CreateNew("Duplicate");
    duplicateWorkspace.Tasks.Add(new TaskCard { Id = validationCard.Id, Title = "Existing card" });
    var duplicate = new WorkspaceSession(duplicateWorkspace);
    Reject<WorkspaceValidationException>(() => validationSource.PrepareTransferTo(duplicate, validationCard.Id));
    Reject<WorkspaceValidationException>(() => validationSource.PrepareTransferTo(validationSource, validationCard.Id));
    var fullWorkspace = Workspace.CreateNew("Full categories");
    fullWorkspace.Categories = Enumerable.Range(0, WorkspaceLimits.MaxCategories).Select(i => $"Category {i}").ToList();
    Reject<WorkspaceValidationException>(() => validationSource.PrepareTransferTo(new WorkspaceSession(fullWorkspace), validationCard.Id));
    fullWorkspace.Categories.Clear();
    fullWorkspace.Tasks = Enumerable.Range(0, WorkspaceLimits.MaxTasks).Select(i => new TaskCard { Title = $"Card {i}", Row = i }).ToList();
    Reject<WorkspaceValidationException>(() => validationSource.PrepareTransferTo(new WorkspaceSession(fullWorkspace), validationCard.Id));
    Check(JsonSerializer.Serialize(validationSource.Workspace) == validationBefore,
        "Duplicate IDs, same-workspace requests and target limits must leave the source and its history unchanged.");
    var emptyLastWorkspace = Workspace.CreateNew("Empty last slice");
    emptyLastWorkspace.Columns = Enumerable.Range(0, WorkspaceLimits.MaxColumns).Select(i => $"Slice {i}").ToList();
    var emptyLast = new WorkspaceSession(emptyLastWorkspace);
    var stale = validationSource.PrepareTransferTo(emptyLast, validationCard.Id);
    Check(stale.Steps[0].After.Tasks.Single().Column == WorkspaceLimits.MaxColumns - 1 && stale.Steps[0].After.Tasks.Single().Row == 0,
        "An empty last slice is used even at the slice limit; moving must not append another slice.");
    validationSource.UpdateTask(validationCard.Id, "Changed during preparation", "", "New category");
    Reject<WorkspaceValidationException>(() => stale.Commit());
    Check(emptyLast.Workspace.Tasks.Count == 0, "Stale prepared changes must not partially mutate the receiving workspace.");
    validationSource.DeleteTask(validationCard.Id);
    Reject<WorkspaceValidationException>(() => validationSource.PrepareTransferTo(emptyLast, validationCard.Id));
}

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void Reject<T>(Action action) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new InvalidOperationException($"Expected {typeof(T).Name}.");
}

static async Task RejectAsync<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T) { return; }
    throw new InvalidOperationException($"Expected {typeof(T).Name}.");
}

static void GraphRules()
{
    var append = NewSession();
    var card = append.CreateTask("拖出新阶段", "", "");
    var beforeAppend = JsonSerializer.Serialize(append.Workspace);
    var lastColumn = append.Workspace.Columns.Count;
    append.MoveTask(card.Id, lastColumn, 0);
    Check(append.Workspace.Columns.Count == lastColumn + 1 && append.Workspace.Tasks[0].Column == lastColumn,
        "Dragging into the next column must append it and move the card together.");
    Check(append.Undo() && JsonSerializer.Serialize(append.Workspace) == beforeAppend,
        "One undo removes the appended column and restores the card.");
    Reject<WorkspaceValidationException>(() => append.MoveTask(card.Id, lastColumn + 1, 0));

    var connection = NewSession();
    var quick = connection.CreateTask("快捷创建", "保留内容", "算法研究");
    var quickChild = connection.CreateTask("已有后续", "", "", [quick.Id]);
    var lateSource = connection.CreateTask("稍晚的来源", "", "PCB 设计", column: 3);
    var occupied = connection.CreateTask("保持位置", "", "", column: 4, row: 0);
    var beforeConnection = JsonSerializer.Serialize(connection.Workspace);
    connection.ConnectTask(lateSource.Id, quick.Id);
    Check(connection.Workspace.Tasks.Single(t => t.Id == quick.Id).Column == 4 &&
          connection.Workspace.Tasks.Single(t => t.Id == quickChild.Id).Column == 5 &&
          connection.Workspace.Tasks.Single(t => t.Id == quick.Id).Row != occupied.Row &&
          connection.Workspace.Links.Any(link => link.SourceId == lateSource.Id && link.TargetId == quick.Id),
        "Connecting a quick task must shift it and necessary successors, avoiding occupied cells.");
    var afterConnection = JsonSerializer.Serialize(connection.Workspace);
    var connectionRevision = connection.Revision;
    Reject<WorkspaceValidationException>(() => connection.ConnectTask(quickChild.Id, lateSource.Id));
    Check(connection.Revision == connectionRevision && JsonSerializer.Serialize(connection.Workspace) == afterConnection,
        "A cyclic connection must leave the entire graph and its history unchanged.");
    Check(connection.Undo() && JsonSerializer.Serialize(connection.Workspace) == beforeConnection &&
          connection.Redo() && JsonSerializer.Serialize(connection.Workspace) == afterConnection,
        "Connection, column creation and successor shifts must undo and redo as one edit.");
    var boundary = NewSession();
    var early = boundary.CreateTask("早期任务", "", "");
    var last = boundary.CreateTask("最后一列", "", "", column: WorkspaceLimits.MaxColumns - 1);
    var beforeBoundary = JsonSerializer.Serialize(boundary.Workspace);
    Reject<WorkspaceValidationException>(() => boundary.ConnectTask(last.Id, early.Id));
    Check(JsonSerializer.Serialize(boundary.Workspace) == beforeBoundary, "Column overflow must not partially move tasks.");

    var session = NewSession();
    var root = session.CreateTask("起点", "", "PCB 设计");
    var branch = session.CreateTask("分支", "", "算法研究", [root.Id]);
    var independent = session.CreateTask("独立", "", "", column: 3);
    var merge = session.CreateTask("汇合", "", "", [branch.Id, independent.Id]);
    Check(root.Column == 0 && branch.Column == 1 && merge.Column == 4,
        "Successors must default to one column after their rightmost source.");
    Check(merge.State == TaskState.NotStarted, "Source state must not start or block successors.");
    session.SetState(merge.Id, TaskState.InProgress);
    Check(session.Workspace.Tasks.Single(t => t.Id == merge.Id).State == TaskState.InProgress,
        "A successor may start while its predecessors have not started.");
    Reject<WorkspaceValidationException>(() => session.AddLink(merge.Id, root.Id));
    Reject<WorkspaceValidationException>(() => session.AddLink(root.Id, root.Id));
    Reject<WorkspaceValidationException>(() => session.MoveTask(branch.Id, 0, 0));
    Reject<WorkspaceValidationException>(() => session.MoveTask(independent.Id, 4, 0));
    session.InsertColumn(1, "插入阶段");
    Check(session.Workspace.Tasks.Single(t => t.Id == branch.Id).Column == 2,
        "Inserting a column must shift tasks at and to its right.");
    Check(session.Workspace.Tasks.Single(t => t.Id == merge.Id).Column == 5,
        "Inserting a column must preserve merge ordering.");
    WorkspaceValidator.Validate(session.Workspace);

    // Start with an empty history so a remove/add implementation cannot masquerade
    // as a single undoable rewire. Existing unrelated edges must also survive.
    var originalGraph = session.Workspace.DeepClone();
    var originalJson = JsonSerializer.Serialize(originalGraph);
    session = new WorkspaceSession(originalGraph);
    session.RewireLink(root.Id, branch.Id, root.Id, independent.Id);
    var rewiredJson = JsonSerializer.Serialize(session.Workspace);
    Check(session.Revision == 1 && session.Workspace.Links.Count == originalGraph.Links.Count &&
          session.Workspace.Links.Any(link => link.SourceId == root.Id && link.TargetId == independent.Id) &&
          !session.Workspace.Links.Any(link => link.SourceId == root.Id && link.TargetId == branch.Id),
        "Rewiring must replace only the selected edge in one transaction.");
    Check(session.Undo() && !session.CanUndo && session.CanRedo &&
          JsonSerializer.Serialize(session.Workspace) == originalJson,
        "One undo must restore the complete graph before rewiring.");
    Check(session.Redo() && session.CanUndo && !session.CanRedo &&
          JsonSerializer.Serialize(session.Workspace) == rewiredJson,
        "One redo must restore the complete rewired graph.");

    foreach (var invalidRewire in new Action<WorkspaceSession>[]
    {
        candidate => candidate.RewireLink(root.Id, independent.Id, Guid.NewGuid(), merge.Id),
        candidate => candidate.RewireLink(root.Id, branch.Id, root.Id, merge.Id),
        candidate => candidate.RewireLink(root.Id, independent.Id, branch.Id, merge.Id),
        candidate => candidate.RewireLink(root.Id, independent.Id, independent.Id, root.Id)
    })
    {
        var candidate = new WorkspaceSession(originalGraph);
        candidate.RewireLink(root.Id, branch.Id, root.Id, independent.Id);
        candidate.RenameWorkspace("Later edit in redo history");
        var laterJson = JsonSerializer.Serialize(candidate.Workspace);
        Check(candidate.Undo(), "Regression setup must leave both undo and redo history.");
        var revision = candidate.Revision;
        Reject<WorkspaceValidationException>(() => invalidRewire(candidate));
        Check(candidate.Revision == revision && candidate.CanUndo && candidate.CanRedo &&
              JsonSerializer.Serialize(candidate.Workspace) == rewiredJson,
            "Missing endpoints, missing original edges, duplicate edges and backward rewires must preserve data and history.");
        Check(candidate.Undo() && !candidate.CanUndo &&
              JsonSerializer.Serialize(candidate.Workspace) == originalJson,
            "A rejected rewire must not add or replace an undo entry.");
        Check(candidate.Redo() && JsonSerializer.Serialize(candidate.Workspace) == rewiredJson &&
              candidate.Redo() && !candidate.CanRedo && JsonSerializer.Serialize(candidate.Workspace) == laterJson,
            "A rejected rewire must preserve the complete existing redo branch.");
    }
}

static void CreationPlacement()
{
    var session = NewSession();
    var earlySource = session.CreateTask("早期来源", "", "", column: 0);
    var laterSource = session.CreateTask("稍晚来源", "", "", column: 2);
    session.InsertColumn(3, "空的最新阶段");
    var beforeCreate = JsonSerializer.Serialize(session.Workspace);
    var independent = session.CreateTask("独立任务", "保留内容", "算法研究");
    Check(independent.State == TaskState.NotStarted,
        "An existing caller that omits the initial status must still create a Not started task.");
    Check(independent.Column == 3 && independent.Row == 0 && session.Workspace.Columns.Count == 4,
        "An independent task must use the last logical column even when it is empty, without appending another column.");
    var afterCreate = JsonSerializer.Serialize(session.Workspace);
    Check(session.Undo() && JsonSerializer.Serialize(session.Workspace) == beforeCreate &&
          session.Redo() && JsonSerializer.Serialize(session.Workspace) == afterCreate,
        "Default placement and task content must undo and redo together without changing existing stages.");
    var nextIndependent = session.CreateTask("同阶段的另一任务", "", "");
    Check(nextIndependent.Column == 3 && nextIndependent.Row == 1,
        "Another independent task must use a free row in the same latest column.");
    var successor = session.CreateTask("早期任务的后续", "", "", [earlySource.Id]);
    var merge = session.CreateTask("多来源后续", "", "", [earlySource.Id, laterSource.Id]);
    Check(successor.Column == 1 && merge.Column == 3 && merge.Row == 2,
        "Source-based defaults must still follow the rightmost source, independently of the latest workspace stage.");
    var explicitPlacement = session.CreateTask("指定较早阶段", "", "", column: 0, row: 5);
    var explicitRow = session.CreateTask("只指定行", "", "", row: 7);
    Check(explicitPlacement.Column == 0 && explicitPlacement.Row == 5 &&
          explicitRow.Column == 3 && explicitRow.Row == 7,
        "Explicit columns and rows must be preserved; an explicit row alone still uses the latest column.");
    var explicitSuccessor = session.CreateTask("指定后续阶段", "", "", [earlySource.Id], column: 2, row: 4);
    Check(explicitSuccessor.Column == 2 && explicitSuccessor.Row == 4,
        "A valid explicit successor column must override only its default placement.");
    var beforeInvalid = JsonSerializer.Serialize(session.Workspace);
    Reject<WorkspaceValidationException>(() => session.CreateTask("无效后续", "", "", [laterSource.Id], column: 1));
    Check(JsonSerializer.Serialize(session.Workspace) == beforeInvalid,
        "An explicit column left of a source must remain invalid and preserve the workspace.");
    WorkspaceValidator.Validate(session.Workspace);

    foreach (var initialState in Enum.GetValues<TaskState>())
    {
        var creation = NewSession();
        var before = JsonSerializer.Serialize(creation.Workspace);
        var initialRevision = creation.Revision;
        var card = creation.CreateTask("Prepared card", "Description", "New category", column: 2, row: 3,
            notes: "Attached note", state: initialState);
        var after = JsonSerializer.Serialize(creation.Workspace);
        Check(card.State == initialState && card.Notes == "Attached note" && card.Column == 2 && card.Row == 3 &&
              creation.Revision == initialRevision + 1,
            "The chosen initial status, note and dropped position must be part of one creation edit.");
        Check(creation.Undo() && JsonSerializer.Serialize(creation.Workspace) == before && !creation.CanUndo,
            "One undo must remove the entire prepared card, its category and appended columns.");
        var revision = creation.Revision;
        foreach (var invalidState in new[] { (TaskState)(-1), (TaskState)int.MaxValue })
            Reject<WorkspaceValidationException>(() => creation.CreateTask("Invalid state", "", "Rejected category",
                column: 4, state: invalidState));
        Check(creation.Revision == revision && JsonSerializer.Serialize(creation.Workspace) == before && creation.CanRedo,
            "Invalid initial statuses must preserve the workspace, revision and pending redo.");
        Check(creation.Redo() && JsonSerializer.Serialize(creation.Workspace) == after && !creation.CanRedo,
            "One redo must restore the same card identity, timestamp, initial status, content and placement.");
    }
}

static void Metadata()
{
    var session = NewSession();
    var startedAt = DateTimeOffset.UtcNow;
    var task = session.CreateTask("Metadata", "Short description", "", notes: "详细备注\nSecond paragraph\twith a tab");
    var createdAt = task.CreatedAt;
    Check(createdAt is { } timestamp && timestamp >= startedAt && timestamp <= DateTimeOffset.UtcNow && timestamp.Offset == TimeSpan.Zero,
        "New tasks must record their actual UTC creation time.");
    Check(task.Description == "Short description" && task.Notes == "详细备注\nSecond paragraph\twith a tab",
        "Long notes must be separate from the description and preserve Unicode and line breaks.");
    var original = JsonSerializer.Serialize(session.Workspace);
    session.UpdateTask(task.Id, "Edited title", "Edited description", "", notes: "Revised notes");
    var edited = JsonSerializer.Serialize(session.Workspace);
    Check(session.Workspace.Tasks.Single().CreatedAt == createdAt,
        "Editing task fields must preserve the original creation time.");
    Check(session.Undo() && JsonSerializer.Serialize(session.Workspace) == original &&
          session.Redo() && JsonSerializer.Serialize(session.Workspace) == edited,
        "Notes and creation time must survive complete undo/redo snapshots.");
    session.UpdateTask(task.Id, "Older client edit", "Description only", "");
    Check(session.Workspace.Tasks.Single().Notes == "Revised notes" && session.Workspace.Tasks.Single().CreatedAt == createdAt,
        "An update that omits notes must preserve notes and creation time.");
    session.UpdateTask(task.Id, "Clear notes", "", "", notes: "");
    Check(session.Workspace.Tasks.Single().Notes.Length == 0, "An explicit empty notes field must clear notes.");
    session.UpdateTask(task.Id, "Maximum notes", "", "", notes: new string('n', WorkspaceLimits.MaxNotesLength));
    var beforeInvalid = JsonSerializer.Serialize(session.Workspace);
    var revision = session.Revision;
    foreach (var notes in new[] { new string('n', WorkspaceLimits.MaxNotesLength + 1), "invalid\0notes" })
        Reject<WorkspaceValidationException>(() => session.UpdateTask(task.Id, "Invalid notes", "", "", notes));
    Check(session.Revision == revision && JsonSerializer.Serialize(session.Workspace) == beforeInvalid,
        "Oversized or invalid notes must preserve the live task and undo history.");
    var invalid = session.Workspace.DeepClone();
    invalid.Tasks[0].Notes = null!;
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(invalid));
    invalid = session.Workspace.DeepClone();
    invalid.Tasks[0].CreatedAt = DateTimeOffset.MinValue;
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(invalid));
}

static void Lifecycle()
{
    var session = NewSession();
    var a = session.CreateTask("A", "保留的描述", "PCB 设计");
    var b = session.CreateTask("B", "", "", [a.Id]);
    var c = session.CreateTask("C", "", "", [b.Id]);
    Reject<WorkspaceValidationException>(() => session.ArchiveTask(a.Id));
    session.SetState(a.Id, TaskState.Stopped);
    Check(session.Workspace.Tasks.Single(t => t.Id == b.Id).State == TaskState.NotStarted,
        "Stopping a task must not cascade to descendants.");
    session.ArchiveTask(a.Id);
    Check(session.Workspace.Tasks.Single(t => t.Id == a.Id).IsArchived && session.Workspace.Links.Count == 2,
        "Archiving must retain content and relationships.");
    session.UnarchiveTask(a.Id);
    var restoredArchive = session.Workspace.Tasks.Single(t => t.Id == a.Id);
    Check(!restoredArchive.IsArchived && restoredArchive.ArchiveHistory.Count == 2 &&
          restoredArchive.Description == "保留的描述", "Archive and restoration must preserve history and text.");
    session.DeleteTask(b.Id);
    Check(session.Workspace.Tasks.Count == 3 &&
          session.Workspace.Tasks.Single(t => t.Id == b.Id).DeletedAt is not null,
        "Deletion must retain a recoverable card.");
    Check(session.Workspace.Links.Count == 0 &&
          session.Workspace.Tasks.Single(t => t.Id == c.Id).DeletedAt is null,
        "Deleting a middle card must remove only incident links without reconnecting or cascading.");
    Check(session.Undo() && session.Workspace.Links.Count == 2,
        "Undo must restore the complete pre-deletion graph.");
    Check(session.Redo() && session.Workspace.Links.Count == 0, "Redo must repeat the deletion.");
    session.RestoreTask(b.Id);
    Check(session.Workspace.Tasks.Single(t => t.Id == b.Id).DeletedAt is null &&
          session.Workspace.Links.Count == 0, "Explicit card restoration must not invent relationships.");
    WorkspaceValidator.Validate(session.Workspace);
}

static void History()
{
    var original = Workspace.CreateNew("原始");
    var session = new WorkspaceSession(original);
    var task = session.CreateTask("初始标题", "", "");
    Check(original.Tasks.Count == 0, "Sessions must not mutate their caller's workspace instance.");
    session.UpdateTask(task.Id, "编辑标题", "中文内容", "算法研究");
    Check(session.Undo() && session.Workspace.Tasks.Single().Title == "初始标题", "Undo must restore text.");
    Check(session.Redo() && session.Workspace.Tasks.Single().Title == "编辑标题", "Redo must restore edits.");
    var snapshot = JsonSerializer.Serialize(session.Workspace);
    Reject<WorkspaceValidationException>(() => session.UpdateTask(task.Id, "", "", ""));
    Check(JsonSerializer.Serialize(session.Workspace) == snapshot, "Rejected mutations must leave data intact.");
    Check(session.Undo(), "A rejected mutation must not add an undo entry.");
    session.SetState(task.Id, TaskState.Completed);
    Check(!session.CanRedo, "A new edit after undo must discard the abandoned redo branch.");

    session = NewSession();
    task = session.CreateTask("历史边界", "", "");
    for (var i = 0; i < WorkspaceLimits.MaxHistoryEntries + 5; i++)
        session.UpdateTask(task.Id, $"编辑 {i}", "", "");
    var undoCount = 0;
    while (session.Undo()) undoCount++;
    Check(undoCount == WorkspaceLimits.MaxHistoryEntries, "Undo history must respect its bounded entry count.");
}

static void Validation()
{
    var malformed = Workspace.CreateNew("未来版本");
    malformed.FormatVersion++;
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(malformed));
    malformed = Workspace.CreateNew("超限");
    malformed.Tasks.AddRange(Enumerable.Range(0, WorkspaceLimits.MaxTasks + 1)
        .Select(_ => new TaskCard { Title = "任务" }));
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(malformed));

    var session = NewSession();
    var a = session.CreateTask("A", "", "");
    var b = session.CreateTask("B", "", "", [a.Id]);
    session.Workspace.Links.Add(new TaskLink { SourceId = b.Id, TargetId = a.Id });
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(session.Workspace));

    session = NewSession();
    a = session.CreateTask("A", "", "");
    session.Workspace.Links.Add(new TaskLink { SourceId = a.Id, TargetId = Guid.NewGuid() });
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(session.Workspace));

    session = NewSession();
    a = session.CreateTask("A", "", "");
    session.Workspace.Tasks.Add(a);
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(session.Workspace));

    session = NewSession();
    session.Workspace.Columns.AddRange(Enumerable.Repeat("阶段", WorkspaceLimits.MaxColumns));
    Reject<WorkspaceValidationException>(() => WorkspaceValidator.Validate(session.Workspace));
    session = NewSession();
    Reject<WorkspaceValidationException>(() => session.CreateTask(new string('字', 100_000), "", ""));
    a = session.CreateTask("来源", "", "");
    Reject<WorkspaceValidationException>(() => session.CreateTask("后续", "", "",
        Enumerable.Repeat(a.Id, WorkspaceLimits.MaxSourcesPerCreation + 1)));
}

static async Task Storage()
{
    var directory = Path.Combine(Path.GetTempPath(), "DeskGhost.Checks", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(directory);
    try
    {
        var path = Path.Combine(directory, "workspace.deskghost.json");
        var session = NewSession();
        var card = session.CreateTask("首次保存", "中文往返", "PCB 设计", notes: "详细备注\n第二段");
        var store = new WorkspaceStore(path);
        await store.SaveAsync(session.Workspace);
        var loaded = await new WorkspaceStore(path).LoadAsync();
        Check(loaded.Tasks.Single().Description == "中文往返" && loaded.Tasks.Single().Notes == "详细备注\n第二段" &&
              loaded.Tasks.Single().CreatedAt == card.CreatedAt, "Saved Unicode task data and creation metadata must round-trip.");

        var competing = new WorkspaceStore(path);
        await competing.LoadAsync();
        session.UpdateTask(card.Id, "第二次保存", "更新内容", "PCB 设计", notes: "Revised notes");
        await store.SaveAsync(session.Workspace);
        await RejectAsync<WorkspaceConflictException>(() => competing.SaveAsync(loaded));
        var current = await new WorkspaceStore(path).LoadAsync();
        Check(current.Tasks.Single().Title == "第二次保存", "A stale writer must not overwrite a newer save.");
        await RejectAsync<WorkspaceConflictException>(() => new WorkspaceStore(path).SaveAsync(loaded));

        var backup = await store.LoadBackupAsync();
        Check(backup.Tasks.Single().Title == "首次保存" && backup.Tasks.Single().Notes == "详细备注\n第二段" &&
              backup.Tasks.Single().CreatedAt == card.CreatedAt, "Replacement saves must retain the previous valid version and metadata.");
        var validBytes = await File.ReadAllBytesAsync(path);
        var validJson = System.Text.Encoding.UTF8.GetString(validBytes);
        var invalidPath = Path.Combine(directory, "invalid.deskghost.json");
        foreach (var json in new[]
        {
            "null", "{}", validJson.Replace($"\"formatVersion\": {WorkspaceLimits.CurrentFormatVersion}", "\"formatVersion\": 999", StringComparison.Ordinal),
            validJson.Insert(1, "\"formatVersion\":1,"), validJson.Insert(1, "\"unexpected\":true,"),
            "{\"tasks\":[" + string.Join(',', Enumerable.Repeat("{}", WorkspaceLimits.MaxTasks + 1)) + "]}",
            "{" + string.Join(',', Enumerable.Range(0, 17).Select(i => $"\"field{i}\":0")) + "}",
            "{\"" + new string('x', 129) + "\":0}"
        })
        {
            await File.WriteAllTextAsync(invalidPath, json);
            await RejectAsync<WorkspaceValidationException>(async () => { await new WorkspaceStore(invalidPath).LoadAsync(); });
            Check(await File.ReadAllTextAsync(invalidPath) == json, "Rejected input files must be preserved unchanged.");
        }
        var invalid = Workspace.CreateNew("无效");
        invalid.Columns.Clear();
        await RejectAsync<WorkspaceValidationException>(() => store.SaveAsync(invalid));
        var afterRejectedSave = await File.ReadAllBytesAsync(path);
        Check(validBytes.SequenceEqual(afterRejectedSave), "Rejected saves must preserve existing bytes.");

        // Build a genuine v1 shape from valid persisted data, without inventing
        // timestamps for tasks created before this metadata was recorded.
        var legacyNode = JsonNode.Parse(validJson)!.AsObject();
        legacyNode["formatVersion"] = 1;
        legacyNode["name"] = "原有工作区名称";
        legacyNode["columns"]![0] = "原有阶段名称";
        foreach (var legacyTask in legacyNode["tasks"]!.AsArray())
        {
            legacyTask!.AsObject().Remove("notes");
            legacyTask.AsObject().Remove("createdAt");
        }
        var legacyPath = Path.Combine(directory, "legacy.deskghost.json");
        var legacyJson = legacyNode.ToJsonString();
        await File.WriteAllTextAsync(legacyPath, legacyJson);
        var legacyStore = new WorkspaceStore(legacyPath);
        var migrated = await legacyStore.LoadAsync();
        Check(migrated.FormatVersion == WorkspaceLimits.CurrentFormatVersion && migrated.Tasks.Single().CreatedAt is null &&
              migrated.Tasks.Single().Notes == "" && migrated.Name == "原有工作区名称" && migrated.Columns[0] == "原有阶段名称",
            "Version 1 must migrate in memory with unknown creation time and unchanged user names/content.");
        Check(await File.ReadAllTextAsync(legacyPath) == legacyJson, "Opening a legacy workspace must not rewrite its file.");
        var legacySession = new WorkspaceSession(migrated);
        legacySession.UpdateTask(card.Id, "Edited legacy task", "Keep unknown creation time", "PCB 设计", "New legacy notes");
        Check(legacySession.Workspace.Tasks.Single().CreatedAt is null,
            "Editing a legacy task must not manufacture a creation timestamp.");
        await legacyStore.SaveAsync(legacySession.Workspace);
        Check(await File.ReadAllTextAsync(legacyStore.BackupPath) == legacyJson,
            "The first v2 save must preserve the exact prior v1 bytes as its backup.");
        var upgraded = await new WorkspaceStore(legacyPath).LoadAsync();
        Check(upgraded.FormatVersion == 2 && upgraded.Tasks.Single().Notes == "New legacy notes" &&
              upgraded.Tasks.Single().CreatedAt is null, "The upgraded file must persist metadata using version 2.");
        var recoveredLegacy = await legacyStore.RecoverBackupAsync();
        Check(recoveredLegacy.Tasks.Single().CreatedAt is null && recoveredLegacy.Tasks.Single().Notes == "" &&
              await File.ReadAllTextAsync(legacyPath) == legacyJson,
            "Recovering a v1 backup must restore its bytes and preserve unknown legacy metadata.");

        foreach (var invalidMetadata in new Action<JsonObject>[]
        {
            node => node["tasks"]![0]!.AsObject().Remove("notes"),
            node => node["tasks"]![0]!.AsObject().Remove("createdAt"),
            node => node["tasks"]![0]!["notes"] = null,
            node => node["tasks"]![0]!["notes"] = new string('x', WorkspaceLimits.MaxNotesLength + 1),
            node => node["tasks"]![0]!["createdAt"] = "not-a-date",
            node => node["formatVersion"] = 1
        })
        {
            var node = JsonNode.Parse(validJson)!.AsObject();
            invalidMetadata(node);
            var json = node.ToJsonString();
            await File.WriteAllTextAsync(invalidPath, json);
            await RejectAsync<WorkspaceValidationException>(async () => { await new WorkspaceStore(invalidPath).LoadAsync(); });
            Check(await File.ReadAllTextAsync(invalidPath) == json,
                "Missing v2 metadata, invalid values and metadata disguised as v1 must be rejected without changing the file.");
        }

        await using (var locked = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            session.UpdateTask(card.Id, "写入失败的更改", "仍在内存", "PCB 设计");
            await RejectAsync<WorkspaceStorageException>(() => store.SaveAsync(session.Workspace));
        }
        var afterLockedSave = await File.ReadAllBytesAsync(path);
        Check(validBytes.SequenceEqual(afterLockedSave), "A locked-file save failure must preserve existing bytes.");

        await File.WriteAllTextAsync(path, "{ damaged workspace");
        var damagedStore = new WorkspaceStore(path);
        await RejectAsync<WorkspaceValidationException>(async () => { await damagedStore.LoadAsync(); });
        Check(await File.ReadAllTextAsync(path) == "{ damaged workspace", "Normal loading must never silently replace corrupt data.");
        var recovered = await damagedStore.RecoverBackupAsync();
        Check(recovered.Tasks.Single().Title == "首次保存", "Explicit recovery must restore the validated backup.");
        Check(Directory.GetFiles(directory).Any(file => Path.GetFileName(file).Contains("corrupt", StringComparison.OrdinalIgnoreCase)),
            "Recovery must retain the damaged original for inspection.");
        WorkspaceValidator.Validate(await new WorkspaceStore(path).LoadAsync());

        var oversizedPath = Path.Combine(directory, "oversized.deskghost.json");
        await using (var oversized = File.Create(oversizedPath)) oversized.SetLength(WorkspaceLimits.MaxFileBytes + 1);
        await RejectAsync<WorkspaceValidationException>(async () => { await new WorkspaceStore(oversizedPath).LoadAsync(); });
    }
    finally
    {
        // Only this test-created GUID directory is removed; no application data is touched.
        Directory.Delete(directory, recursive: true);
    }
}
