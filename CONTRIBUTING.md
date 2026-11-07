# Contributing

Thanks for helping improve search-console-axi.

- Never contact a real Google service from tests. Use the fake-Google harness; tests must not require credentials or modify a real Search Console property.
- Keep CLI output in TOON, reject invalid arguments before credentials or network access, and use structured errors with exit codes 0, 1, or 2.
- Keep default output compact and represent unavailable data honestly.
- Indexing API writes must remain preview-first and require explicit `--confirm`; never run confirmed writes against live Google during development or tests.

Pull requests must use a conventional commit title, go through no-mistakes, and pass required checks. Classify changes against the existing behavior:

- **restore** restores documented or established behavior.
- **opt-in** adds behavior users explicitly enable without changing defaults.
- **new-default** changes behavior users get without opting in and requires maintainer approval.
- **cannot-tell** means available evidence does not establish the effect; clarify it before approval.

Before opening a pull request, run:

```sh
npm run format:check && npm run lint && npm run build && npm test
```

## Releases

Use conventional commit messages such as `feat:`, `fix:`, and `docs:`. Do not hand-edit release-generated files or bump `package.json`'s version; release-please owns them. See the README for release details.
