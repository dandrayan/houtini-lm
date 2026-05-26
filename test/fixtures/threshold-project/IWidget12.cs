namespace ThresholdProject;

/// <summary>12-method interface — above the documented delegation threshold.</summary>
public interface IWidget12
{
    Task<string?> GetByIdAsync(int id, CancellationToken ct = default);
    Task<string?> GetByNameAsync(string name, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetByTagAsync(string tag, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetPageAsync(int page, int pageSize, CancellationToken ct = default);
    Task<int> CountAsync(CancellationToken ct = default);
    Task<bool> ExistsAsync(int id, CancellationToken ct = default);
    Task<int> CreateAsync(string name, string tag, CancellationToken ct = default);
    Task<bool> UpdateAsync(int id, string name, CancellationToken ct = default);
    Task<bool> UpdateTagAsync(int id, string tag, CancellationToken ct = default);
    Task<bool> DeleteAsync(int id, CancellationToken ct = default);
    Task DeleteAllByTagAsync(string tag, CancellationToken ct = default);
}
