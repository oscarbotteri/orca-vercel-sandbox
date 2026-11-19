# Open questions

Decisions still to make. Answered ones move to an ADR in `docs/adr/` and leave this file.

1. **How long does the timeout extension need to be** to keep a connected sandbox alive without letting a forgotten one run for a day?
2. **Default image or custom image?** Installing `sshd` and `websocat` on every create (packages survive a stop, so not on wake) is slower but needs no registry setup. `websocat` is not in the default image's `apt` repositories, so it would have to be downloaded as a binary.
3. **How should the plugin pick up Vercel credentials?** A token in the shell profile (as Prized does with its API key), or the `sandbox login` session.
