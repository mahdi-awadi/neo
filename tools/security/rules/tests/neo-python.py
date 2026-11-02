# Fixture for rules/custom/neo-python.yaml — intentionally vulnerable. Excluded from scans.
import logging, subprocess

def view(request, User, user, client):
    # ruleid: neo-py-mass-assignment
    User(**request.json)
    # ruleid: neo-py-secret-in-log
    logging.info("login %s", user.password)
    # ok: neo-py-secret-in-log
    logging.info("login %s", user.email)
    r = client.chat.completions.create()
    out = r.choices[0].message.content
    # ruleid: neo-py-llm-output-to-sink
    subprocess.run(out)
