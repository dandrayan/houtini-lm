namespace RetryProject;

/// <summary>An immutable chunk of data with a numeric key and text payload.</summary>
public sealed record DataChunk(int Key, string Payload);
