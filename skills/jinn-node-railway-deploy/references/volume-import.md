# Import `.operate` and `.gemini` into Railway Volume

Run from local `jinn-node/` where `.operate/` exists.

**Prerequisite:** `railway ssh` requires a running container. On first-time deployment, the real worker will crash without `.operate/` on the volume. Deploy with an idle start command first — see SKILL.md step 5.

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

- `railway ssh` requires Railway CLI auth and a running deployment.
- On first deploy, the container needs an idle start command (e.g., `tail -f /dev/null`) since the real worker crashes without `.operate/`. See SKILL.md step 5.
- **Fallback:** If `railway ssh` fails or is unavailable, use the Railway dashboard shell (Project > Service > Shell tab) to run the tar commands manually.
