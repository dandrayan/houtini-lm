namespace ThresholdProject;

public sealed class InMemoryWidget3 : IWidget3
{
    private readonly Dictionary<int, string> _store = new();
    private int _nextId = 1;

    public Task<string?> GetByIdAsync(int id, CancellationToken ct = default)
    {
        return _store.TryGetValue(id, out var value) ? Task.FromResult<string?>(value) : Task.FromResult<string?>(null);
    }

    public Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default)
    {
        return Task.FromResult<IReadOnlyList<string>>(_store.Values.ToList());
    }

    public Task<int> CreateAsync(string name, CancellationToken ct = default)
    {
        var id = _nextId++;
        _store[id] = name;
        return Task.FromResult(id);
    }
}