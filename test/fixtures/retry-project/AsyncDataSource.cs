namespace RetryProject;

using System.Runtime.CompilerServices;

public sealed class AsyncDataSource
{
    private readonly IReadOnlyList<DataChunk> _items;

    public AsyncDataSource(IReadOnlyList<DataChunk> items) => _items = items;

    public async IAsyncEnumerable<DataChunk> WhereAsync(Func<DataChunk, bool> predicate, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        foreach (var item in _items)
        {
            await Task.Delay(1, cancellationToken);
            if (predicate(item))
                yield return item;
        }
    }

    public async IAsyncEnumerable<TResult> SelectAsync<TResult>(Func<DataChunk, CancellationToken, Task<TResult>> transform, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        foreach (var item in _items)
        {
            await Task.Delay(1, cancellationToken);
            yield return await transform(item, cancellationToken);
        }
    }
}