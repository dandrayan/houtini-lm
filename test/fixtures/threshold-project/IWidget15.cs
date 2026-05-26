namespace ThresholdProject;

/// <summary>15-method interface — bonus test for gemma4 + NotImplementedException stubs.</summary>
public interface IWidget15
{
    Task<string?> GetByIdAsync(int id, CancellationToken ct = default);
    Task<string?> GetByNameAsync(string name, CancellationToken ct = default);
    Task<string?> GetBySlugAsync(string slug, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetByTagAsync(string tag, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetByOwnerAsync(string owner, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetPageAsync(int page, int pageSize, CancellationToken ct = default);
    Task<int> CountAsync(CancellationToken ct = default);
    Task<int> CountByTagAsync(string tag, CancellationToken ct = default);
    Task<bool> ExistsAsync(int id, CancellationToken ct = default);
    Task<int> CreateAsync(string name, string tag, string owner, CancellationToken ct = default);
    Task<bool> UpdateAsync(int id, string name, CancellationToken ct = default);
    Task<bool> UpdateTagAsync(int id, string tag, CancellationToken ct = default);
    Task<bool> UpdateOwnerAsync(int id, string owner, CancellationToken ct = default);
    Task<bool> DeleteAsync(int id, CancellationToken ct = default);
}
