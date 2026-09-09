using System.Text.Json;
using DeskGhost.Core;

if (args.Contains("--benchmark", StringComparer.Ordinal))
{
    Benchmark();
    return 0;
}

var checks = new (string Name, Func<Task> Run)[]
{
    ("Branching, merging and forward-only links", Sync(GraphRules)),
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
        var card = session.CreateTask("首次保存", "中文往返", "PCB 设计");
        var store = new WorkspaceStore(path);
        await store.SaveAsync(session.Workspace);
        var loaded = await new WorkspaceStore(path).LoadAsync();
        Check(loaded.Tasks.Single().Description == "中文往返", "Saved Unicode task data must round-trip.");

        var competing = new WorkspaceStore(path);
        await competing.LoadAsync();
        session.UpdateTask(card.Id, "第二次保存", "更新内容", "PCB 设计");
        await store.SaveAsync(session.Workspace);
        await RejectAsync<WorkspaceConflictException>(() => competing.SaveAsync(loaded));
        var current = await new WorkspaceStore(path).LoadAsync();
        Check(current.Tasks.Single().Title == "第二次保存", "A stale writer must not overwrite a newer save.");
        await RejectAsync<WorkspaceConflictException>(() => new WorkspaceStore(path).SaveAsync(loaded));

        var backup = await store.LoadBackupAsync();
        Check(backup.Tasks.Single().Title == "首次保存", "Replacement saves must retain the previous valid version.");
        var validBytes = await File.ReadAllBytesAsync(path);
        var validJson = System.Text.Encoding.UTF8.GetString(validBytes);
        var invalidPath = Path.Combine(directory, "invalid.deskghost.json");
        foreach (var json in new[]
        {
            "null", "{}", validJson.Replace("\"formatVersion\": 1", "\"formatVersion\": 999", StringComparison.Ordinal),
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
