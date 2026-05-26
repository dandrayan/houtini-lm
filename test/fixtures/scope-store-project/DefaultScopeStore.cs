using OpenIddict.Abstractions;
using System.Runtime.CompilerServices;

namespace ScopeStoreProject;

public sealed class DefaultScopeStore : IScopeStore
{
    private readonly IOpenIddictScopeManager _scopeManager;

    public DefaultScopeStore(IOpenIddictScopeManager scopeManager)
    {
        _scopeManager = scopeManager;
    }

    public async Task<bool> ValidateScopeExistsAsync(string scopeName, CancellationToken cancellationToken = default)
    {
        return await _scopeManager.FindByNameAsync(scopeName, cancellationToken) is not null;
    }

    public async IAsyncEnumerable<string> GetAllScopeNamesAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // ListAsync<TResult> requires Func<IQueryable<object>, IQueryable<TResult>>;
        // pass identity to retrieve all scope entities, then extract each name.
        await foreach (var scope in _scopeManager.ListAsync<object>(q => q, cancellationToken))
        {
            var name = await _scopeManager.GetNameAsync(scope, cancellationToken);
            if (name is not null) yield return name;
        }
    }
}