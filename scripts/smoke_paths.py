"""Path encoding shared by isolated DSH smoke fixtures."""


def _utf16_units(value: str):
    encoded = value.encode("utf-16-be", errors="surrogatepass")
    for index in range(0, len(encoded), 2):
        yield int.from_bytes(encoded[index:index + 2], "big")


def project_key(cwd: str) -> str:
    """Mirror DSH session-persistence-jsonl's projectKey UTF-16 encoding."""
    if not cwd:
        raise ValueError("cannot encode an empty project path")
    readable = []
    separator_run = False
    for code in _utf16_units(cwd):
        char = chr(code)
        if char in "/\\:":
            if not separator_run:
                readable.append("-")
            separator_run = True
        elif char != "~" and (char.isascii() and (char.isalnum() or char in "._-")):
            readable.append(char)
            separator_run = False
        else:
            readable.append(f"~{code:04X}")
            separator_run = False
    slug = "".join(readable).lstrip("-") or "root"
    return f"--{slug[:251]}--"
