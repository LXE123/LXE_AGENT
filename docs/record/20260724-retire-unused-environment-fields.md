# Retire unused environment fields

Status: `Accepted`

The runtime configuration surface had accumulated environment fields that no
production code read, including retired logistics-service settings and obsolete
agent stream tuning names. Keeping them in templates suggested behavior that no
longer existed and made environment ownership harder to understand.

The unused fields are removed from source templates and runtime defaults. The
Gateway scheduler continues to use its composition-level concurrency limit of
two; it is no longer documented as an environment setting. Configuration
hygiene tests now reject the retired names if they return to tracked env files.
