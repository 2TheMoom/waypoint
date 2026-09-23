"""Direct-mode tests for the Waypoint contract."""

import json
from datetime import datetime, timezone

CONTRACT = "contracts/waypoint.py"
CHALLENGE_WINDOW_SECONDS = 600

T0 = "2026-01-01T00:00:00Z"
T0_TS = int(datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc).timestamp())
DEADLINE = T0_TS + 3600  # 1 hour out

URL = "https://deliverable.example.com/status"
MARKER = "SHIPPED-Q3-2026"
DESC = "Deploy the marketing site with the Q3 pricing table live"


def _mock_marker(vm, present: bool):
    vm.clear_mocks()
    body = f"<html>build ok - {MARKER if present else 'nothing here'}</html>"
    vm.mock_web(r"deliverable\.example\.com/status", {"method": "GET", "status": 200, "body": body})


def _mock_dispute_llm(vm, verdict: str, present: bool = True, reasoning: str = "because"):
    body = f"<html>build ok - {MARKER if present else 'nothing here'}</html>"
    vm.mock_web(r"deliverable\.example\.com/status", {"method": "GET", "status": 200, "body": body})
    vm.mock_llm(
        r".*adjudicating a disputed deliverable.*",
        json.dumps({"verdict": verdict, "reasoning": reasoning}),
    )


def _create(direct_vm, contract, client, provider, engagement_id="wp-1", value=1000, deadline=DEADLINE):
    direct_vm.sender = client
    direct_vm.value = value
    contract.create_engagement(engagement_id, "0x" + provider.hex(), DESC, URL, MARKER, deadline)
    direct_vm.value = 0


# ---------------------------------------------------------------------------
# create_engagement
# ---------------------------------------------------------------------------


def test_create_engagement_stores_fields(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)

    e = contract.get_engagement("wp-1")
    assert e["status"] == "funded"
    assert e["amount"] == 1000
    assert e["deadline"] == DEADLINE
    assert e["deliverable_description"] == DESC
    assert e["verification_url"] == URL
    assert e["verification_marker"] == MARKER
    assert e["submitted_at"] == 0
    assert e["verified_at"] == 0
    assert e["dispute_reason"] == ""
    assert e["challenge_deadline"] == 0


def test_create_engagement_duplicate_id_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)

    with direct_vm.expect_revert("already exists"):
        _create(direct_vm, contract, direct_alice, direct_bob)


def test_create_engagement_zero_value_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    direct_vm.sender = direct_alice
    direct_vm.value = 0

    with direct_vm.expect_revert("positive amount"):
        contract.create_engagement("wp-1", "0x" + direct_bob.hex(), DESC, URL, MARKER, DEADLINE)


def test_create_engagement_provider_equals_client_fails(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    direct_vm.sender = direct_alice
    direct_vm.value = 1000

    with direct_vm.expect_revert("cannot be the same"):
        contract.create_engagement("wp-1", "0x" + direct_alice.hex(), DESC, URL, MARKER, DEADLINE)


def test_create_engagement_empty_description_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    direct_vm.sender = direct_alice
    direct_vm.value = 1000

    with direct_vm.expect_revert("cannot be empty"):
        contract.create_engagement("wp-1", "0x" + direct_bob.hex(), "", URL, MARKER, DEADLINE)


def test_create_engagement_non_https_url_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    direct_vm.sender = direct_alice
    direct_vm.value = 1000

    with direct_vm.expect_revert("https://"):
        contract.create_engagement("wp-1", "0x" + direct_bob.hex(), DESC, "http://x.com", MARKER, DEADLINE)


def test_create_engagement_empty_marker_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    direct_vm.sender = direct_alice
    direct_vm.value = 1000

    with direct_vm.expect_revert("marker cannot be empty"):
        contract.create_engagement("wp-1", "0x" + direct_bob.hex(), DESC, URL, "", DEADLINE)


def test_create_engagement_past_deadline_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    direct_vm.sender = direct_alice
    direct_vm.value = 1000

    with direct_vm.expect_revert("must be in the future"):
        contract.create_engagement("wp-1", "0x" + direct_bob.hex(), DESC, URL, MARKER, T0_TS - 1)


# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------


def test_submit_happy_path(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.sender = direct_bob
    contract.submit("wp-1")

    e = contract.get_engagement("wp-1")
    assert e["status"] == "submitted"
    assert e["submitted_at"] == T0_TS


def test_submit_by_non_provider_fails(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only the provider"):
        contract.submit("wp-1")


def test_submit_wrong_status_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = direct_bob
    contract.submit("wp-1")

    with direct_vm.expect_revert("not awaiting submission"):
        contract.submit("wp-1")


def test_submit_after_deadline_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob, deadline=T0_TS + 100)

    direct_vm.warp("2026-01-01T00:05:00Z")  # 300s later, past the 100s deadline
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Deadline has passed"):
        contract.submit("wp-1")


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------


def test_verify_happy_path(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = direct_bob
    contract.submit("wp-1")

    _mock_marker(direct_vm, present=True)
    contract.verify("wp-1")

    e = contract.get_engagement("wp-1")
    assert e["status"] == "verified"
    assert e["verified_at"] == T0_TS
    assert e["challenge_deadline"] == T0_TS + CHALLENGE_WINDOW_SECONDS


def test_verify_marker_not_found_reverts_cleanly_then_succeeds(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = direct_bob
    contract.submit("wp-1")

    _mock_marker(direct_vm, present=False)
    with direct_vm.expect_revert("marker not found"):
        contract.verify("wp-1")
    assert contract.get_engagement("wp-1")["status"] == "submitted"

    _mock_marker(direct_vm, present=True)
    contract.verify("wp-1")
    assert contract.get_engagement("wp-1")["status"] == "verified"


def test_verify_wrong_status_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)

    with direct_vm.expect_revert("not awaiting verification"):
        contract.verify("wp-1")


# ---------------------------------------------------------------------------
# challenge
# ---------------------------------------------------------------------------


def _to_verified(direct_vm, contract, client, provider, engagement_id="wp-1", **kwargs):
    _create(direct_vm, contract, client, provider, engagement_id=engagement_id, **kwargs)
    direct_vm.sender = provider
    contract.submit(engagement_id)
    _mock_marker(direct_vm, present=True)
    contract.verify(engagement_id)


def test_challenge_happy_path(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.sender = direct_alice
    contract.challenge("wp-1", "The pricing table shows old numbers, not Q3")

    e = contract.get_engagement("wp-1")
    assert e["status"] == "disputed"
    assert e["dispute_reason"] == "The pricing table shows old numbers, not Q3"


def test_challenge_by_non_client_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Only the client"):
        contract.challenge("wp-1", "reason")


def test_challenge_wrong_status_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("not in a challengeable state"):
        contract.challenge("wp-1", "reason")


def test_challenge_window_closed_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.warp("2026-01-01T00:15:00Z")  # 900s later, past the 600s window
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Challenge window has closed"):
        contract.challenge("wp-1", "reason")


def test_challenge_empty_reason_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("reason is required"):
        contract.challenge("wp-1", "")


# ---------------------------------------------------------------------------
# resolve_dispute
# ---------------------------------------------------------------------------


def test_resolve_dispute_uphold_releases(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    contract.challenge("wp-1", "Doesn't look right to me")

    _mock_dispute_llm(direct_vm, verdict="uphold", reasoning="The marker and full page confirm Q3 pricing is live")
    direct_vm.sender = direct_bob
    contract.resolve_dispute("wp-1")

    e = contract.get_engagement("wp-1")
    assert e["status"] == "released"
    assert "Q3 pricing" in e["resolution_note"]


def test_resolve_dispute_overturn_refunds(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    contract.challenge("wp-1", "Prices are stale")

    _mock_dispute_llm(direct_vm, verdict="overturn", reasoning="Prices shown are last quarter's")
    direct_vm.sender = direct_bob
    contract.resolve_dispute("wp-1")

    assert contract.get_engagement("wp-1")["status"] == "refunded"


def test_resolve_dispute_by_non_provider_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    contract.challenge("wp-1", "reason")

    with direct_vm.expect_revert("Only the provider"):
        contract.resolve_dispute("wp-1")


def test_resolve_dispute_wrong_status_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not under dispute"):
        contract.resolve_dispute("wp-1")


# ---------------------------------------------------------------------------
# release
# ---------------------------------------------------------------------------


def test_release_happy_path(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)

    direct_vm.warp("2026-01-01T00:15:00Z")  # past the 600s challenge window
    contract.release("wp-1")

    assert contract.get_engagement("wp-1")["status"] == "released"


def test_release_within_window_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob)

    with direct_vm.expect_revert("Challenge window is still open"):
        contract.release("wp-1")


def test_release_wrong_status_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob)

    with direct_vm.expect_revert("not verified"):
        contract.release("wp-1")


# ---------------------------------------------------------------------------
# reclaim_timeout
# ---------------------------------------------------------------------------


def test_reclaim_timeout_happy_path(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob, deadline=T0_TS + 100)

    direct_vm.warp("2026-01-01T00:05:00Z")
    direct_vm.sender = direct_alice
    contract.reclaim_timeout("wp-1")

    assert contract.get_engagement("wp-1")["status"] == "refunded"


def test_reclaim_timeout_by_non_client_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob, deadline=T0_TS + 100)

    direct_vm.warp("2026-01-01T00:05:00Z")
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Only the client"):
        contract.reclaim_timeout("wp-1")


def test_reclaim_timeout_before_deadline_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob, deadline=T0_TS + 3600)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("has not passed yet"):
        contract.reclaim_timeout("wp-1")


def test_reclaim_timeout_wrong_status_fails(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _to_verified(direct_vm, contract, direct_alice, direct_bob, deadline=T0_TS + 100)

    direct_vm.warp("2026-01-01T00:05:00Z")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("not awaiting submission"):
        contract.reclaim_timeout("wp-1")


# ---------------------------------------------------------------------------
# views / listing
# ---------------------------------------------------------------------------


def test_get_engagement_unknown_fails(direct_vm, direct_deploy):
    contract = direct_deploy(CONTRACT)
    with direct_vm.expect_revert("not found"):
        contract.get_engagement("nonexistent")


def test_get_all_engagement_ids(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    assert contract.get_all_engagement_ids() == []

    _create(direct_vm, contract, direct_alice, direct_bob, engagement_id="wp-1")
    _create(direct_vm, contract, direct_alice, direct_bob, engagement_id="wp-2")

    assert contract.get_all_engagement_ids() == ["wp-1", "wp-2"]


def test_two_engagements_are_independent(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = direct_deploy(CONTRACT)
    direct_vm.warp(T0)
    _create(direct_vm, contract, direct_alice, direct_bob, engagement_id="wp-1", value=500)
    _create(direct_vm, contract, direct_alice, direct_charlie, engagement_id="wp-2", value=900)

    assert contract.get_engagement("wp-1")["amount"] == 500
    assert contract.get_engagement("wp-2")["amount"] == 900
    assert contract.get_engagement("wp-1")["status"] == "funded"
    assert contract.get_engagement("wp-2")["status"] == "funded"
