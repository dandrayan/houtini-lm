namespace ThresholdProject;

public sealed class InMemoryWidget8 : IWidget8
{
    private readonly Dictionary<int, (string Name, string Tag)> _store = new();
    private int _nextId = 1;

    public Task<string?> GetByIdAsync(int id, CancellationToken ct = default)
    {
        if (_store.TryGetValue(id, out var value))
            return Task.FromResult<string?>(value.Name);
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
        return Task.FromResult<IReadOnlyList<string>>(_store.Values.Where(v => v.Tag == tag).Select(v => v.Name).ToList());
    }

    public Task<int> CreateAsync(string name, string tag, CancellationToken ct = default)
    {
        var id = _nextId++;
        _store[id] = (name, tag);
        return Task.FromResult(id);
    }

    public Task<bool> UpdateAsync(int id, string name, CancellationToken ct = default)
    {
        if (!_store.ContainsKey(id))
            return Task.FromResult(false);
        _store[id] = (name, _store[id].Tag);
        return Task.FromResult(true);
    }

    public Task<bool> UpdateTagAsync(int id, string tag, CancellationToken ct = default)
    {
        if (!_store.ContainsKey(id))
            return Task.FromResult(false);
        _store[id] = (_store[id].Name, tag);
        return Task.FromResult(true);
    }

    public Task<bool> DeleteAsync(int id, CancellationToken ct = default)
    {
        if (!_store.ContainsKey(id))
            return Task.FromResult(false);
        _store.Remove(id);
        return Task.FromResult(true);
    }
}