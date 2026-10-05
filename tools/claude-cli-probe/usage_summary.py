def summarize(payload, requested_model):
    usage = payload.get("modelUsage") if isinstance(payload, dict) else None
    if isinstance(usage, dict):
        models = sorted(k for k in usage if isinstance(k, str) and k)
    else:
        models = []
    return {
        "requested_model": requested_model,
        "actual_models": models,
        "resolved": bool(models),
    }
