# Import `.operate` and `.gemini` into Railway Volume

Run from local `jinn-node/` where `.operate/` exists.

**Recommended:** Use `bash scripts/deploy-railway.sh` which handles import automatically. This reference is for manual troubleshooting only.

**Prerequisites:**
- `railway ssh` requires a running container. On first-time deployment, deploy with an idle start command first (the deploy script does this automatically).
- Railway SSH uses WebSocket and does NOT forward stdin pipes. Use base64 encoding instead of `tar | railway ssh` piping.

## Create remote directories

```bash
railway ssh -- 'mkdir -p /home/jinn/.operate /home/jinn/.gemini'
```

## Import `.operate` (excluding services/)

`.operate/services/` is typically ~373MB and gets recreated at runtime. Exclude it to stay within the ~2MB command argument limit.

```bash
payload=$(tar czf - --exclude='services' .operate | base64)
railway ssh -- "echo '$payload' | base64 -d | tar xzf - -C /home/jinn"
```

## Import `.gemini` (if using Gemini CLI OAuth)

Exclude bulky subdirectories that get recreated at runtime:

```bash
payload=$(tar czf - -C "$HOME" --exclude='antigravity' --exclude='antigravity-browser-profile' --exclude='tmp' .gemini | base64)
railway ssh -- "echo '$payload' | base64 -d | tar xzf - -C /home/jinn"
```

## Fix volume ownership

The Railway container runs SSH as root, but the worker runs as `jinn`. Fix permissions after import:

```bash
railway ssh -- 'chown -R jinn:jinn /home/jinn'
```

## Verify import

```bash
railway ssh -- 'ls -la /home/jinn/.operate /home/jinn/.gemini'
```

## Notes

- `railway ssh` requires Railway CLI auth and a running deployment.
- **Do NOT use `bash -lc` wrappers** — quoting breaks through Railway's SSH WebSocket transport. Pass commands directly.
- **Do NOT pipe stdin** (e.g., `tar | railway ssh`) — Railway SSH doesn't forward stdin. Use base64 encoding as shown above.
- **Fallback:** If `railway ssh` fails, use the Railway dashboard shell (Project > Service > Shell tab).
- **Large directories** (>1.5MB tar): Too large for base64 command args. Use an intermediary (e.g., presigned S3 URL + wget from inside the container).
