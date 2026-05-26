namespace ThresholdProject;

/// <summary>3-method interface.</summary>
public interface IWidget3
{
    Task<string?> GetByIdAsync(int id, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default);
    Task<int> CreateAsync(string name, CancellationToken ct = default);
}
