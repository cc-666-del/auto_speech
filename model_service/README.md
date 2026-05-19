# Model Service

This folder contains the local model service used by the desktop app.

The current implementation is a dependency-free Python HTTP service. It is intentionally lightweight so the desktop app can validate model lifecycle behavior before a real voice cloning model is installed.

## Endpoints

- `GET /health`
- `GET /status`
- `POST /load`
- `POST /unload`
- `POST /generate`
- `POST /shutdown`

## Run Manually

```powershell
py -3.11 model_service/main.py --port 8765
```

Then visit:

```text
http://127.0.0.1:8765/status
```

Generate placeholder audio:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8765/generate -ContentType 'application/json' -Body '{"text":"这是一段测试旁白。"}'
```

## Future Model Integration

Replace the placeholder `load_model` and `unload_model` functions with real model logic.

Real unload logic should clear Python references and CUDA cache:

```python
del model
torch.cuda.empty_cache()
torch.cuda.ipc_collect()
```
