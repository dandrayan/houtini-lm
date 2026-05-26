namespace ThresholdProject;

public sealed class InMemoryWidget5 : IWidget5
{
    private readonly Dictionary<int, string> _store = new();
    private int _nextId = 1;

    public Task<string?> GetByIdAsync(int id, CancellationToken ct = default)
    {
        _store.TryGetValue(id, out var name);
        return Task.FromResult(name);
    }

    public Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default)
    {
        return Task.FromResult<IReadOnlyList<string>>(_store.Values.ToList());
    }

    public Task<int> CreateAsync(string name, CancellationToken ct = default)
    {
        var id = _nextId++;
        _store.Add(id, name);
        return Task.FromResult(id);
    }

    public Task<bool> UpdateAsync(int id, string name, CancellationToken ct = default)
    {
        if (!_store.ContainsKey(id)) return Task.FromResult(false);
        _store[id] = name;
        return Task.FromResult(true);
    }

    public Task<bool> DeleteAsync(int id, CancellationToken ct = default)
    {
        if (!_store.ContainsKey(id)) return Task.FromResult(false);
        _store.Remove(id);
        return Task.FromResult(true);
    }
}