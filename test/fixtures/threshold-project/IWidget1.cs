namespace ThresholdProject;

/// <summary>1-method interface — baseline.</summary>
public interface IWidget1
{
    Task<string?> GetByIdAsync(int id, CancellationToken ct = default);
}
