namespace ThresholdProject;

/// <summary>5-method interface.</summary>
public interface IWidget5
{
    Task<string?> GetByIdAsync(int id, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default);
    Task<int> CreateAsync(string name, CancellationToken ct = default);
    Task<bool> UpdateAsync(int id, string name, CancellationToken ct = default);
    Task<bool> DeleteAsync(int id, CancellationToken ct = default);
}
