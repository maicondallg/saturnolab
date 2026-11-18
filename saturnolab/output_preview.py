"""Bounded JSON previews for IPython. Also executed in external kernels."""

from itertools import islice

PREVIEW_MIME = "application/vnd.saturno.preview+json"


def _label(value):
    if isinstance(value, str):
        return value[:240] + ("…" if len(value) > 240 else "")
    if isinstance(value, (bytes, bytearray)):
        return repr(value[:80]) + ("…" if len(value) > 80 else "")
    if isinstance(value, int) and value.bit_length() > 1024:
        return f"int ({value.bit_length()} bits)"
    if isinstance(value, (int, float, complex, bool, type(None))):
        return str(value)
    if type(value).__module__.split(".")[0] in ("datetime", "numpy", "pandas"):
        if getattr(value, "ndim", 0) == 0:
            return str(value)[:240]
    return type(value).__name__


def build_preview(root):
    remaining = 512
    ancestors = set()

    def visit(value, depth):
        nonlocal remaining
        remaining -= 1
        kind = type(value).__name__
        result = {"kind": kind}
        if id(value) in ancestors:
            return {**result, "value": "↻"}
        if isinstance(value, dict):
            size, pairs = len(value), value.items()
        elif isinstance(value, range):
            try:
                size = len(value)
            except OverflowError:
                return {**result, "value": repr(value)[:240]}
            if size > 9007199254740991:
                return {**result, "value": repr(value)[:240]}
            pairs = enumerate(value)
        elif isinstance(value, (list, tuple, set, frozenset)):
            size, pairs = len(value), enumerate(value)
        elif kind == "ndarray" and type(value).__module__.startswith("numpy"):
            result["info"] = f"{value.shape} · {value.dtype}"
            if not value.ndim:
                return {**result, "value": _label(value.item())}
            size, pairs = len(value), enumerate(value)
        elif kind == "Series" and type(value).__module__.startswith("pandas"):
            result["info"] = f"{_label(value.name)} · {value.dtype}"
            size, pairs = len(value), value.items()
        elif type(value).__module__.startswith("sklearn.") and hasattr(value, "get_params"):
            params = value.get_params(deep=False)
            size, pairs = len(params), params.items()
        else:
            if isinstance(value, str):
                return {**result, "value": value[:1024] + ("…" if len(value) > 1024 else "")}
            return {**result, "value": _label(value)}
        result.update(size=size, entries=[])
        if depth < 5:
            ancestors.add(id(value))
            for key, child in islice(pairs, 64 if depth == 0 else 16):
                if remaining <= 0:
                    break
                result["entries"].append([_label(key), visit(child, depth + 1)])
            ancestors.remove(id(value))
        return result

    return visit(root, 0)


def install_output_preview(shell):
    from IPython.core.formatters import BaseFormatter

    class PreviewFormatter(BaseFormatter):
        format_type = PREVIEW_MIME
        print_method = "_repr_saturno_preview_"
        _return_type = dict

    formatter = PreviewFormatter(parent=shell.display_formatter)

    for cls in (list, tuple, set, frozenset, range, dict, str, bytes, int, float, complex, bool):
        formatter.for_type(cls, build_preview)
    for module, name in (
        ("numpy", "ndarray"), ("numpy", "generic"),
        ("pandas.core.series", "Series"), ("pandas", "Series"),
        ("sklearn.base", "BaseEstimator"),
    ):
        formatter.for_type_by_name(module, name, build_preview)
    shell.display_formatter.formatters[PREVIEW_MIME] = formatter

    # Pandas truncates HTML cells to 50 characters before the browser can lay
    # them out. Widen that default for the displayed sample only.
    def dataframe_html(frame):
        import pandas as pd

        if pd.get_option("display.max_colwidth") != 50:
            return frame._repr_html_()
        rows, cols = frame.shape
        rows = min(rows, pd.get_option("display.max_rows") or rows)
        cols = min(cols, pd.get_option("display.max_columns") or cols)
        # Spread the extra text budget across the visible cells of wide frames.
        width = max(50, min(512, 262144 // max(1, rows * cols)))
        with pd.option_context("display.max_colwidth", width):
            return frame._repr_html_()

    html = shell.display_formatter.formatters["text/html"]
    for module in ("pandas", "pandas.core.frame"):
        html.for_type_by_name(module, "DataFrame", dataframe_html)
