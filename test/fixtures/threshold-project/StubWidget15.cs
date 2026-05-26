namespace ThresholdProject;

public sealed class StubWidget15 : IWidget15
{
    public Task<string?> GetByIdAsync(int id, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<string?> GetByNameAsync(string name, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<string?> GetBySlugAsync(string slug, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<IReadOnlyList<string>> GetAllAsync(CancellationToken ct = default) => throw new NotImplementedException();
    public Task<IReadOnlyList<string>> GetByTagAsync(string tag, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<IReadOnlyList<string>> GetByOwnerAsync(string owner, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<IReadOnlyList<string>> GetPageAsync(int page, int pageSize, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<int> CountAsync(CancellationToken ct = default) => throw new NotImplementedException();
    public Task<int> CountByTagAsync(string tag, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<bool> ExistsAsync(int id, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<int> CreateAsync(string name, string tag, string owner, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<bool> UpdateAsync(int id, string name, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<bool> UpdateTagAsync(int id, string tag, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<bool> UpdateOwnerAsync(int id, string owner, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<bool> DeleteAsync(int id, CancellationToken ct = default) => throw new NotImplementedException();
}