namespace ThresholdProject;

public sealed class InMemoryWidget1 : IWidget1
{
    private readonly Dictionary<int, string> _items = new();

    public Task<string?> GetByIdAsync(int id, CancellationToken ct = default)
    {
        _items.TryGetValue(id, out var value);
        return Task.FromResult(value);
    }
}