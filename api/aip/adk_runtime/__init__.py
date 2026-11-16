"""The AIP JKN agents on Google ADK. This package runs in its own environment (.venv-adk: google-adk, litellm, httpx),
started per run by aip/runs.py; it never imports the platform's modules (except the dependency-free aip.models). It
reaches the platform only over its API, as the user who started the run (a job token): the tools call the Nexus and
the other apps, and the models are called through the platform's gateway (aip/gateway.py) so the spend guard applies.

    platform.py   the API client
    tools.py      the tools of each domain agent, scoped to the object types the agent is responsible for
    agents.py     the ADK agents: orchestrator, domain agents, writer, validator, UI composer
    main.py       one run: reads its input on stdin, writes JSON events on stdout
"""
