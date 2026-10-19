import sys

def main(argv: list[str]) -> int:
    """Print a greeting."""
    name = argv[1] if len(argv) > 1 else "world"
    print(f"Hello, {name}!")  # comment
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
