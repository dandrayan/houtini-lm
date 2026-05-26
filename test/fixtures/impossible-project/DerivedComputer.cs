namespace ImpossibleProject;

public abstract class BaseComputer
{
    public virtual int Compute(int x) => x;
    public abstract string Describe();
}

public static class BaseComputerExtensions
{
    public static int Compute(this BaseComputer _, int x) => x;
}

public class DerivedComputer : BaseComputer
{
    public static override int Compute(int x) => x;
    public override string Describe() => "static override impossible";
}