# Import `.operate` and `.gemini` into Railway Volume

Run from local `jinn-node/` where `.operate/` exists.

## Verify remote target directories

```bash
railway ssh -- bash -lc 'mkdir -p /home/jinn/.operate /home/jinn/.gemini && ls -la /home/jinn'
```

## Stream `.operate`

```bash
tar czf - .operate | railway ssh -- bash -lc 'tar xzf - -C /home/jinn'
```

## Stream `.gemini` (if using Gemini CLI OAuth)

```bash
[ -d "$HOME/.gemini" ] && tar czf - -C "$HOME" .gemini | railway ssh -- bash -lc 'tar xzf - -C /home/jinn'
```

## Verify import

```bash
railway ssh -- bash -lc 'ls -la /home/jinn/.operate /home/jinn/.gemini'
```

## Notes

- This requires Railway CLI auth and SSH access to the deployed service.
- If `tar` streaming is blocked by your shell/CI, use Railway dashboard shell and copy manually.
