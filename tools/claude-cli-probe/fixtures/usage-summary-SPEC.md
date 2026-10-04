# Usage summary fixture

Implement `summarize(payload, requested_model)` in `usage_summary.py`.

Return exactly this shape:

```python
{
    'requested_model': requested_model,
    'actual_models': [...],
    'resolved': bool,
}
```

`actual_models` is the sorted list of non-empty string keys in `payload['modelUsage']` only when `payload` is a dict and `modelUsage` is a dict. For every other input shape, use an empty list. `resolved` is true exactly when at least one actual model name was found. Never infer an actual model from `requested_model`.

Do not read or write outside this fixture. The test file is fixed input and must not be changed. The requested implementation task is to edit `usage_summary.py` only.
