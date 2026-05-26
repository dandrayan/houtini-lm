namespace ThresholdProject;

public sealed class InMemoryWidget12 : IWidget12
{
    private readonly Dictionary<int, (string Name, string Tag)> _store = new();
    private int _nextId = 1;

    public Task<string?> GetByIdAsync(int id, CancellationToken ct = default)
    {
        if (_store.TryGetValue(id, out var item))
            return Task.FromResult<string?>(item.Name);
        return Task.FromResult<string?>(null);
    }

    public Task<string?> GetByNameAsync(string name, CancellationToken ct = default)
    {
        var item = _store.Values.FirstOrDefault(v => v.Name == name);
        return Task.FromResult<string?>(item.Name);
    }

    public Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default)
    {
        return Task.FromResult<IReadOnlyList<string>>(_store.Values.Select(v => v.Name).ToList());
    }

    public Task<IReadOnlyList<string>> GetByTagAsync(string tag, CancellationToken ct = default)
    {
        var results = _store.Values.Where(v => v.Tag == tag).Select(v => v.Name).ToList();
        return Task.FromResult<IReadOnlyList<string>>(results);
    }

    public Task<IReadOnlyList<string>> GetPageAsync(int page, int pageSize, CancellationToken ct = default)
    {
        var sorted = _store.OrderBy(kvp => kvp.Key).Select(kvp => kvp.Value.Name).ToList();
        var startIndex = (page - 1) * pageSize;
        var items = sorted.Skip(startIndex).Take(pageSize).ToList();
        return Task.FromResult<IReadOnlyList<string>>(items);
    }

    public Task<int> CountAsync(CancellationToken ct = default)
    {
        return Task.FromResult(_store.Count);
    }

    public Task<bool> ExistsAsync(int id, CancellationToken ct = default)
    {
        return Task.FromResult(_store.ContainsKey(id));
    }

    public Task<int> CreateAsync(string name, string tag, CancellationToken ct = default)
    {
        var id = _nextId++;
        _store[id] = (name, tag);
        return Task.FromResult(id);
    }

    public Task<bool> UpdateAsync(int id, string name, CancellationToken ct = default)
    {
        if (_store.TryGetValue(id, out var _))
        {
            _store[id] = (name, _store[id].Tag);
            return Task.FromResult(true);
        }
        return Task.FromResult(false);
    }

    public Task<bool> UpdateTagAsync(int id, string tag, CancellationToken ct = default)
    {
        if (_store.TryGetValue(id, out var _))
        {
            _store[id] = (_store[id].Name, tag);
            return Task.FromResult(true);
        }
        return Task.FromResult(false);
    }

    public Task<bool> DeleteAsync(int id, CancellationToken ct = default)
    {
        return Task.FromResult(_store.Remove(id));
    }

    public Task DeleteAllByTagAsync(string tag, CancellationToken ct = default)
    {
        var idsToDelete = _store.Where(kvp => kvp.Value.Tag == tag).Select(kvp => kvp.Key).ToList();
        foreach (var id in idsToDelete)
            _store.Remove(id);
        return Task.CompletedTask;
    }
}