using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DeskGhost.Core;

// The desktop process is the only client. One bounded JSON line in, one line out;
// commands, including durable saves, are processed sequentially.
Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);
var host = new WorkspaceHost();
while (await ReadLineBoundedAsync(Console.In, 256 * 1024) is { } line)
{
    string? id = null;
    try
    {
        using var request = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 20 });
        id = request.RootElement.GetProperty("id").GetString();
        var method = request.RootElement.GetProperty("method").GetString() ?? "";
        var payload = request.RootElement.TryGetProperty("payload", out var value) ? value : default;
        var result = await host.DispatchAsync(method, payload);
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { id, ok = true, data = result }, WorkspaceHost.Json));
    }
    catch (Exception error) when (error is not OutOfMemoryException)
    {
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { id, ok = false, error = error.Message }, WorkspaceHost.Json));
    }
}

static async Task<string?> ReadLineBoundedAsync(TextReader input, int limit)
{
    var line = new StringBuilder();
    var buffer = new char[1];
    while (await input.ReadAsync(buffer.AsMemory()) > 0)
    {
        if (buffer[0] == '\n') return line.ToString();
        if (buffer[0] != '\r') line.Append(buffer[0]);
        // Invalid framing is fatal: continuing would mistake a suffix for a command.
        if (line.Length > limit) throw new InvalidDataException("桌面请求超过允许大小，数据服务已安全停止。");
    }
    return line.Length == 0 ? null : line.ToString();
}

internal sealed class WorkspaceHost
{
    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        MaxDepth = 20,
        Converters = { new JsonStringEnumConverter(allowIntegerValues: false) }
    };
    private const int OpenDocumentLimit = 12;
    private const int OpenDataLimit = 16 * 1024 * 1024;
    private readonly List<Document> documents = [];
    private Guid? activeWorkspaceId;

    public async Task<object> DispatchAsync(string method, JsonElement payload)
    {
        object? result = null;
        switch (method)
        {
            case "state": break;
            case "openWorkspace":
            case "recoverWorkspace":
            {
                var path = Path.GetFullPath(Text(payload, "path"));
                var existing = documents.FirstOrDefault(d => d.Store.Path.Equals(path, StringComparison.OrdinalIgnoreCase));
                if (existing is not null) { activeWorkspaceId = existing.Session.Workspace.Id; break; }
                CheckDocumentCount();
                var store = new WorkspaceStore(path);
                var workspace = method == "recoverWorkspace" ? await store.RecoverBackupAsync() : await store.LoadAsync();
                if (documents.Any(d => d.Session.Workspace.Id == workspace.Id))
                    throw new WorkspaceValidationException("这个工作区的另一个副本已打开，请先关闭原副本。");
                CheckBudget(workspace, null);
                documents.Add(new Document(workspace, store, saved: true));
                activeWorkspaceId = workspace.Id;
                break;
            }
            case "createWorkspace":
            {
                CheckDocumentCount();
                var workspace = Workspace.CreateNew(Text(payload, "name"));
                CheckBudget(workspace, null);
                var store = new WorkspaceStore(Path.Combine(Text(payload, "folder"), workspace.Id.ToString("N") + ".deskghost.json"));
                // A failed first save remains visible and recoverable with Save As.
                var document = new Document(workspace, store, saved: false);
                documents.Add(document);
                activeWorkspaceId = workspace.Id;
                await document.SaveAsync();
                break;
            }
            case "activateWorkspace": activeWorkspaceId = Find(payload).Session.Workspace.Id; break;
            case "closeWorkspace":
            {
                var document = Find(payload);
                if (!await document.SaveAsync()) break;
                documents.Remove(document);
                if (activeWorkspaceId == document.Session.Workspace.Id) activeWorkspaceId = documents.FirstOrDefault()?.Session.Workspace.Id;
                break;
            }
            case "saveWorkspace": await Find(payload).SaveAsync(); break;
            case "flush":
                foreach (var document in documents) await document.SaveAsync();
                result = new { canExit = documents.All(d => !d.IsDirty) };
                break;
            case "exportSnapshot":
            {
                // A fresh helper can validate and rescue the desktop's last acknowledged
                // snapshot after its original data process has failed. Source and target
                // paths are supplied only by the trusted desktop main process.
                var snapshot = await new WorkspaceStore(Text(payload, "sourcePath")).LoadAsync();
                var target = new WorkspaceStore(Text(payload, "path"));
                await target.SaveAsync(snapshot);
                result = new { path = target.Path };
                break;
            }
            case "saveAs":
            case "exportWorkspace":
            {
                var document = Find(payload);
                var path = Path.GetFullPath(Text(payload, "path"));
                if (documents.Any(d => d != document && d.Store.Path.Equals(path, StringComparison.OrdinalIgnoreCase)))
                    throw new WorkspaceValidationException("另一个工作区正在使用此文件。");
                if (document.Store.Path.Equals(path, StringComparison.OrdinalIgnoreCase)) await document.SaveAsync();
                else
                {
                    // A new store refuses existing files and backups. Export must never
                    // silently adopt and overwrite a different file's save baseline.
                    var target = new WorkspaceStore(path);
                    await target.SaveAsync(document.Session.Workspace);
                    if (method == "saveAs") document.Adopt(target);
                }
                result = new { path };
                break;
            }
            default:
            {
                var document = Find(payload);
                if (method is "undo" or "redo")
                {
                    // Bytes reserves the largest document snapshot during this session,
                    // so travelling history cannot overflow the shared transport budget.
                    if (method == "undo") document.Session.Undo(); else document.Session.Redo();
                }
                else
                {
                    // Preview validates the complete graph and the total IPC/data budget
                    // before changing the live undo history or workspace.
                    var preview = new WorkspaceSession(document.Session.Workspace);
                    Apply(preview, method, payload);
                    CheckBudget(preview.Workspace, document);
                    result = Apply(document.Session, method, payload);
                }
                document.Bytes = Math.Max(document.Bytes, JsonSerializer.SerializeToUtf8Bytes(document.Session.Workspace, Json).Length);
                await document.SaveAsync();
                break;
            }
        }
        return State(result);
    }

    private object State(object? result) => new
    {
        documents = documents.Select(d => new
        {
            id = d.Session.Workspace.Id,
            path = d.Store.Path,
            workspace = d.Session.Workspace,
            canUndo = d.Session.CanUndo,
            canRedo = d.Session.CanRedo,
            saveStatus = d.IsDirty ? "error" : "saved",
            saveError = d.SaveError
        }).ToArray(),
        activeWorkspaceId,
        result
    };

    private static object? Apply(WorkspaceSession session, string method, JsonElement p)
    {
        switch (method)
        {
            case "createTask":
                var sources = p.TryGetProperty("sourceIds", out var ids)
                    ? ids.EnumerateArray().Select(v => v.GetGuid()).ToArray() : [];
                var task = session.CreateTask(Text(p, "title"), Text(p, "description", ""), Text(p, "category", ""),
                    sources, OptionalInt(p, "column"), OptionalInt(p, "row"));
                return new { taskId = task.Id };
            case "updateTask": session.UpdateTask(Id(p, "taskId"), Text(p, "title"), Text(p, "description", ""), Text(p, "category", "")); break;
            case "setState":
                if (!Enum.TryParse<TaskState>(Text(p, "state"), out var state) || !Enum.IsDefined(state))
                    throw new WorkspaceValidationException("任务状态无效。");
                session.SetState(Id(p, "taskId"), state); break;
            case "moveTask": session.MoveTask(Id(p, "taskId"), Integer(p, "column"), Integer(p, "row")); break;
            case "insertColumn": session.InsertColumn(Integer(p, "index"), p.TryGetProperty("label", out var label) ? label.GetString() : null); break;
            case "renameColumn": session.RenameColumn(Integer(p, "index"), Text(p, "label")); break;
            case "renameWorkspace": session.RenameWorkspace(Text(p, "name")); break;
            case "addCategory": session.AddCategory(Text(p, "category")); break;
            case "addLink": session.AddLink(Id(p, "sourceId"), Id(p, "targetId")); break;
            case "connectTask": session.ConnectTask(Id(p, "sourceId"), Id(p, "targetId")); break;
            case "removeLink": session.RemoveLink(Id(p, "sourceId"), Id(p, "targetId")); break;
            case "rewireLink": session.RewireLink(Id(p, "sourceId"), Id(p, "targetId"), Id(p, "newSourceId"), Id(p, "newTargetId")); break;
            case "deleteTask": session.DeleteTask(Id(p, "taskId")); break;
            case "restoreTask": session.RestoreTask(Id(p, "taskId")); break;
            case "archiveTask": session.ArchiveTask(Id(p, "taskId")); break;
            case "unarchiveTask": session.UnarchiveTask(Id(p, "taskId")); break;
            default: throw new WorkspaceValidationException("不支持的操作。");
        }
        return null;
    }

    private Document Find(JsonElement payload)
    {
        var id = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("workspaceId", out var value) ? value.GetGuid() : activeWorkspaceId;
        return documents.FirstOrDefault(d => d.Session.Workspace.Id == id)
            ?? throw new WorkspaceValidationException("请先打开一个工作区。");
    }
    private void CheckDocumentCount()
    {
        if (documents.Count >= OpenDocumentLimit) throw new WorkspaceValidationException("最多同时打开 12 个工作区，请先关闭一个。");
    }
    private void CheckBudget(Workspace candidate, Document? replacing)
    {
        var size = Math.Max(replacing?.Bytes ?? 0, JsonSerializer.SerializeToUtf8Bytes(candidate, Json).Length);
        if (size + documents.Where(d => d != replacing).Sum(d => d.Bytes) > OpenDataLimit)
            throw new WorkspaceValidationException("同时打开的数据已达 16 MiB 上限，请先关闭其他工作区；已有数据保持不变。");
    }
    private static string Text(JsonElement p, string name, string? fallback = null) =>
        p.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : fallback
            ?? throw new WorkspaceValidationException($"缺少有效字段：{name}");
    private static Guid Id(JsonElement p, string name) => p.GetProperty(name).GetGuid();
    private static int Integer(JsonElement p, string name) => p.GetProperty(name).GetInt32();
    private static int? OptionalInt(JsonElement p, string name) => p.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value.GetInt32() : null;

    private sealed class Document
    {
        private long savedRevision;
        public WorkspaceSession Session { get; }
        public WorkspaceStore Store { get; private set; }
        public int Bytes { get; set; }
        public string? SaveError { get; private set; }
        public bool IsDirty => Session.Revision != savedRevision;
        public Document(Workspace workspace, WorkspaceStore store, bool saved)
        {
            Session = new WorkspaceSession(workspace);
            Store = store;
            savedRevision = saved ? 0 : -1;
            Bytes = JsonSerializer.SerializeToUtf8Bytes(workspace, Json).Length;
        }
        public async Task<bool> SaveAsync()
        {
            if (!IsDirty) return true;
            try
            {
                await Store.SaveAsync(Session.Workspace);
                savedRevision = Session.Revision;
                SaveError = null;
                return true;
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                SaveError = "保存失败，内存中的更改仍保留：" + error.Message;
                return false;
            }
        }
        public void Adopt(WorkspaceStore store)
        {
            Store = store;
            savedRevision = Session.Revision;
            SaveError = null;
        }
    }
}
