namespace ScopeStoreProject;

/// <summary>Validates and queries OAuth 2.0 scopes.</summary>
public interface IScopeStore
{
    /// <summary>Returns true if a scope with the given name exists, false otherwise.</summary>
    Task<bool> ValidateScopeExistsAsync(string scopeName, CancellationToken cancellationToken = default);

    /// <summary>Returns all registered scope names.</summary>
    IAsyncEnumerable<string> GetAllScopeNamesAsync(CancellationToken cancellationToken = default);
}
