using System.Security;
using System.Security.Cryptography;

namespace DeskGhost.Core;

/// <summary>
/// Stores one workspace per file. Saves flush a same-directory temporary file before
/// atomically replacing the primary and retaining its last valid bytes as .bak.
/// A store must load an existing primary before saving it; external changes are rejected.
/// </summary>
public sealed class WorkspaceStore
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private byte[]? expectedHash;
    private Guid? expectedId;

    public WorkspaceStore(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        Path = System.IO.Path.GetFullPath(path);
    }

    public string Path { get; }
    public string BackupPath => Path + ".bak";

    public async Task<Workspace> LoadAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var bytes = await ReadBoundedAsync(Path, cancellationToken).ConfigureAwait(false);
            var workspace = WorkspaceJson.Deserialize(bytes);
            expectedHash = SHA256.HashData(bytes);
            expectedId = workspace.Id;
            return workspace;
        }
        catch (Exception error) when (IsFileError(error))
        {
            throw new WorkspaceStorageException($"无法读取工作区：{error.Message}", error);
        }
        finally { gate.Release(); }
    }

    /// <summary>Reads and validates the backup without changing the primary or save baseline.</summary>
    public async Task<Workspace> LoadBackupAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return WorkspaceJson.Deserialize(await ReadBoundedAsync(BackupPath, cancellationToken).ConfigureAwait(false));
        }
        catch (Exception error) when (IsFileError(error))
        {
            throw new WorkspaceStorageException($"无法读取工作区备份：{error.Message}", error);
        }
        finally { gate.Release(); }
    }

    public async Task SaveAsync(Workspace workspace, CancellationToken cancellationToken = default)
    {
        // Capture before the first await. Session edits replace their document instance.
        var bytes = WorkspaceJson.Serialize(workspace);
        var id = workspace.Id;
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        string? temporaryPath = null;
        try
        {
            WorkspaceValidator.Require(expectedId is null || expectedId == id,
                "不能用另一个工作区覆盖当前文件，请另存为新文件。");
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            using var fileLock = AcquireWriteLock();
            await VerifyUnchangedAsync(cancellationToken).ConfigureAwait(false);
            temporaryPath = await WriteTemporaryAsync(bytes, cancellationToken).ConfigureAwait(false);
            await VerifyUnchangedAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();

            if (expectedHash is null)
                File.Move(temporaryPath, Path, overwrite: false);
            else
                File.Replace(temporaryPath, Path, BackupPath, ignoreMetadataErrors: false);

            temporaryPath = null;
            expectedHash = SHA256.HashData(bytes);
            expectedId = id;
        }
        catch (Exception error) when (IsFileError(error))
        {
            throw new WorkspaceStorageException($"保存工作区失败，已有文件及备份已保留：{error.Message}", error);
        }
        finally
        {
            DeleteTemporary(temporaryPath);
            gate.Release();
        }
    }

    /// <summary>
    /// Explicitly restores a validated backup. The replaced primary is retained under
    /// a unique .corrupt name; the .bak remains unchanged. Never called by normal loading.
    /// </summary>
    public async Task<Workspace> RecoverBackupAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        string? temporaryPath = null;
        try
        {
            using var fileLock = AcquireWriteLock();
            var bytes = await ReadBoundedAsync(BackupPath, cancellationToken).ConfigureAwait(false);
            var workspace = WorkspaceJson.Deserialize(bytes);
            temporaryPath = await WriteTemporaryAsync(bytes, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (File.Exists(Path))
            {
                var rejectedPath = Path + $".{DateTime.UtcNow:yyyyMMddHHmmssfff}.{Guid.NewGuid():N}.corrupt";
                File.Replace(temporaryPath, Path, rejectedPath, ignoreMetadataErrors: false);
            }
            else
            {
                File.Move(temporaryPath, Path, overwrite: false);
            }

            temporaryPath = null;
            expectedHash = SHA256.HashData(bytes);
            expectedId = workspace.Id;
            return workspace;
        }
        catch (Exception error) when (IsFileError(error))
        {
            throw new WorkspaceStorageException($"恢复备份失败，已有数据已保留：{error.Message}", error);
        }
        finally
        {
            DeleteTemporary(temporaryPath);
            gate.Release();
        }
    }

    private async Task VerifyUnchangedAsync(CancellationToken cancellationToken)
    {
        if (expectedHash is null)
        {
            if (File.Exists(Path) || File.Exists(BackupPath))
                throw new WorkspaceConflictException("目标工作区或备份已存在，请先打开原文件，或另存为新文件。");
            return;
        }
        if (!File.Exists(Path))
            throw new WorkspaceConflictException("工作区文件已被移动或删除；请另存为新文件以保留当前更改。");
        byte[] currentHash;
        try { currentHash = await ReadHashBoundedAsync(Path, cancellationToken).ConfigureAwait(false); }
        catch (WorkspaceValidationException)
        {
            throw new WorkspaceConflictException("磁盘上的工作区已变更且超出允许大小，请另存为新文件。");
        }
        if (!CryptographicOperations.FixedTimeEquals(expectedHash, currentHash))
            throw new WorkspaceConflictException("工作区已被其他窗口或程序修改；请重新打开，或另存为新文件以保留当前更改。");
    }

    private FileStream AcquireWriteLock()
    {
        try
        {
            // Keep this tiny sidecar file: deleting locks after release introduces races.
            return new FileStream(Path + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1);
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
        {
            throw new WorkspaceConflictException("工作区正在由另一操作保存，请稍后重试。");
        }
    }

    private async Task<string> WriteTemporaryAsync(byte[] bytes, CancellationToken cancellationToken)
    {
        var temporaryPath = Path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            await using var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                16 * 1024, FileOptions.Asynchronous | FileOptions.WriteThrough);
            await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            stream.Flush(flushToDisk: true);
            return temporaryPath;
        }
        catch
        {
            DeleteTemporary(temporaryPath);
            throw;
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            16 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        WorkspaceValidator.Require(stream.Length is > 0 and <= WorkspaceLimits.MaxFileBytes,
            $"工作区文件为空或超过 {WorkspaceLimits.MaxFileBytes / 1024 / 1024} MiB 限制，已停止读取。");
        var bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
        var extra = new byte[1];
        WorkspaceValidator.Require(await stream.ReadAsync(extra, cancellationToken).ConfigureAwait(false) == 0,
            "读取期间文件大小发生变化，请重新打开。");
        return bytes;
    }

    private static async Task<byte[]> ReadHashBoundedAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            16 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var length = stream.Length;
        WorkspaceValidator.Require(length is > 0 and <= WorkspaceLimits.MaxFileBytes,
            "磁盘上的工作区文件为空或超过允许大小。");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[16 * 1024];
        long read = 0;
        int count;
        while ((count = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
        {
            read += count;
            WorkspaceValidator.Require(read <= WorkspaceLimits.MaxFileBytes, "读取期间文件大小超出允许范围。");
            hash.AppendData(buffer, 0, count);
        }
        WorkspaceValidator.Require(read == length, "读取期间文件大小发生变化，请重新打开。");
        return hash.GetHashAndReset();
    }

    private static bool IsFileError(Exception error) => error is IOException or UnauthorizedAccessException or SecurityException
        && error is not WorkspaceStorageException;

    private static void DeleteTemporary(string? path)
    {
        if (path is null) return;
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (SecurityException) { }
    }
}
