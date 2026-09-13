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
            throw new WorkspaceStorageException($"Cannot read the workspace: {error.Message}", error);
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
            throw new WorkspaceStorageException($"Cannot read the workspace backup: {error.Message}", error);
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
                "A different workspace cannot overwrite this file. Save to a new file.");
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
            throw new WorkspaceStorageException($"Saving failed; the existing workspace file and backup were preserved: {error.Message}", error);
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
            throw new WorkspaceStorageException($"Backup recovery failed; existing data was preserved: {error.Message}", error);
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
                throw new WorkspaceConflictException("The target workspace or backup already exists. Open the original first or save to a new file.");
            return;
        }
        if (!File.Exists(Path))
            throw new WorkspaceConflictException("The workspace file was moved or deleted. Save to a new file to keep these changes.");
        byte[] currentHash;
        try { currentHash = await ReadHashBoundedAsync(Path, cancellationToken).ConfigureAwait(false); }
        catch (WorkspaceValidationException)
        {
            throw new WorkspaceConflictException("The workspace on disk changed and exceeds its size limit. Save to a new file.");
        }
        if (!CryptographicOperations.FixedTimeEquals(expectedHash, currentHash))
            throw new WorkspaceConflictException("Another window or application changed this workspace. Reopen it or save to a new file to keep these changes.");
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
            throw new WorkspaceConflictException("Another operation is saving this workspace. Try again shortly.");
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
            $"The workspace file is empty or exceeds {WorkspaceLimits.MaxFileBytes / 1024 / 1024} MiB. Reading was stopped.");
        var bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
        var extra = new byte[1];
        WorkspaceValidator.Require(await stream.ReadAsync(extra, cancellationToken).ConfigureAwait(false) == 0,
            "The file size changed while reading. Reopen the file.");
        return bytes;
    }

    private static async Task<byte[]> ReadHashBoundedAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            16 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var length = stream.Length;
        WorkspaceValidator.Require(length is > 0 and <= WorkspaceLimits.MaxFileBytes,
            "The workspace file on disk is empty or exceeds its size limit.");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[16 * 1024];
        long read = 0;
        int count;
        while ((count = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
        {
            read += count;
            WorkspaceValidator.Require(read <= WorkspaceLimits.MaxFileBytes, "The file exceeded its size limit while reading.");
            hash.AppendData(buffer, 0, count);
        }
        WorkspaceValidator.Require(read == length, "The file size changed while reading. Reopen the file.");
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
