# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from dataclasses import dataclass
from datetime import datetime, timezone
from genlayer import *

CHALLENGE_WINDOW_SECONDS = 600  # 10 minutes

REQUEST_HEADERS = {
    "Accept": "text/html,application/json,*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}


@allow_storage
@dataclass
class Engagement:
    client: Address
    provider: Address
    deliverable_description: str
    verification_url: str
    verification_marker: str
    amount: u256
    deadline: u256
    status: str  # funded | submitted | verified | disputed | released | refunded
    created_at: u256
    submitted_at: u256
    verified_at: u256
    dispute_reason: str  # "" until challenged
    resolution_note: str  # LLM's reasoning on a resolved dispute - informational only


class Waypoint(gl.Contract):
    """A verified milestone escrow - a client funds real GEN against a
    deliverable, and GenVM validators independently confirm it before the
    money moves, escalating to reasoned judgment only when genuinely
    disputed.

    create_engagement locks in the deliverable, a verification_url, and a
    verification_marker the client expects to find there once the work is
    done, and escrows the agreed amount. submit() lets the provider mark
    the deliverable ready. verify() - the common path - is fully
    deterministic: validators independently fetch verification_url and
    check whether verification_marker is present in the response, with no
    LLM involved. That is enough to prove a deliverable is genuinely live
    ("the page is deployed", "the PR shows Merged", "the API reports
    status: complete") without either party's word for it.

    A deterministic pass isn't the same as a deliverable being *right*, so
    the client has a CHALLENGE_WINDOW_SECONDS window after verification to
    dispute it with a reason. Only a genuine dispute escalates to
    gl.nondet.exec_prompt - validators re-fetch the live content and weigh
    the client's specific objection against it, and only the verdict
    (uphold/overturn) is consensus-critical; the reasoning text is
    informational. If nobody disputes within the window, release() pays
    the provider. If the provider never submits by the deadline, the
    client can reclaim the escrow.

    Known platform limitation, disclosed rather than hidden: emit_transfer
    does not currently deliver value on GenLayer's Bradbury testnet
    (github.com/genlayerlabs/genvm-manager/issues/20, independently
    reproduced from this account as recently as the night this contract
    was built). Every state transition up to and including the release/
    refund decision is real and independently verifiable; the final
    balance movement is blocked by this platform bug, not a defect here.
    """

    engagements: TreeMap[str, Engagement]
    engagement_ids: DynArray[str]

    def __init__(self):
        pass

    def _now(self) -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _get(self, engagement_id: str) -> Engagement:
        if engagement_id not in self.engagements:
            raise gl.vm.UserError(f"Engagement '{engagement_id}' not found")
        return self.engagements[engagement_id]

    @gl.public.write.payable
    def create_engagement(
        self,
        engagement_id: str,
        provider: str,
        deliverable_description: str,
        verification_url: str,
        verification_marker: str,
        deadline: int,
    ) -> None:
        if engagement_id in self.engagements:
            raise gl.vm.UserError(f"Engagement '{engagement_id}' already exists")

        value = gl.message.value
        if value <= 0:
            raise gl.vm.UserError("Must escrow a positive amount")

        client = gl.message.sender_address
        provider_addr = Address(provider)
        if provider_addr == client:
            raise gl.vm.UserError("Provider cannot be the same as the client")
        if not deliverable_description:
            raise gl.vm.UserError("deliverable_description cannot be empty")
        if not verification_url.startswith("https://"):
            raise gl.vm.UserError("verification_url must start with https://")
        if not verification_marker:
            raise gl.vm.UserError("verification_marker cannot be empty")

        now = self._now()
        if deadline <= now:
            raise gl.vm.UserError("deadline must be in the future")

        self.engagements[engagement_id] = Engagement(
            client=client,
            provider=provider_addr,
            deliverable_description=deliverable_description,
            verification_url=verification_url,
            verification_marker=verification_marker,
            amount=value,
            deadline=deadline,
            status="funded",
            created_at=now,
            submitted_at=0,
            verified_at=0,
            dispute_reason="",
            resolution_note="",
        )
        self.engagement_ids.append(engagement_id)

    @gl.public.write
    def submit(self, engagement_id: str) -> None:
        e = self._get(engagement_id)
        if gl.message.sender_address != e.provider:
            raise gl.vm.UserError("Only the provider can submit this engagement")
        if e.status != "funded":
            raise gl.vm.UserError(f"Engagement is not awaiting submission (status: {e.status})")
        if self._now() >= e.deadline:
            raise gl.vm.UserError("Deadline has passed - the client can reclaim the escrow")

        e.status = "submitted"
        e.submitted_at = self._now()

    def _fetch_marker_found(self, url: str, marker: str) -> dict:
        def leader_fn() -> dict:
            try:
                resp = gl.nondet.web.request(url, method="GET", headers=REQUEST_HEADERS)
                body = (resp.body or b"").decode("utf-8", errors="ignore")
            except Exception:
                return {"found": False}
            return {"found": marker.lower() in body.lower()}

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            mine = leader_fn()
            return mine["found"] == leaders_res.calldata["found"]

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

    @gl.public.write
    def verify(self, engagement_id: str) -> None:
        e = self._get(engagement_id)
        if e.status != "submitted":
            raise gl.vm.UserError(f"Engagement is not awaiting verification (status: {e.status})")

        result = self._fetch_marker_found(e.verification_url, e.verification_marker)
        if not result.get("found"):
            raise gl.vm.UserError(
                "Verification marker not found at the deliverable URL - "
                "the deliverable does not yet satisfy the agreement"
            )

        e.status = "verified"
        e.verified_at = self._now()

    @gl.public.write
    def challenge(self, engagement_id: str, reason: str) -> None:
        e = self._get(engagement_id)
        if gl.message.sender_address != e.client:
            raise gl.vm.UserError("Only the client can challenge this engagement")
        if e.status != "verified":
            raise gl.vm.UserError(f"Engagement is not in a challengeable state (status: {e.status})")
        if self._now() > e.verified_at + CHALLENGE_WINDOW_SECONDS:
            raise gl.vm.UserError("Challenge window has closed")
        if not reason:
            raise gl.vm.UserError("A challenge reason is required")

        e.status = "disputed"
        e.dispute_reason = reason

    def _adjudicate_dispute(self, e: Engagement) -> dict:
        def leader_fn() -> dict:
            try:
                resp = gl.nondet.web.request(e.verification_url, method="GET", headers=REQUEST_HEADERS)
                body = (resp.body or b"")[:4000].decode("utf-8", errors="ignore")
            except Exception:
                body = "(the verification URL could not be fetched)"

            prompt = (
                "You are adjudicating a disputed deliverable in an escrow agreement "
                "between a client and a provider.\n\n"
                f"Agreed deliverable: {e.deliverable_description}\n"
                f"Verification URL: {e.verification_url}\n"
                f'An automated check already found the marker "{e.verification_marker}" '
                "present at this URL, but the client disputes that this means the "
                "deliverable is genuinely done.\n"
                f"Client's dispute reason: {e.dispute_reason}\n\n"
                "Current live content fetched from the verification URL (may be truncated):\n"
                "---\n" + body + "\n---\n\n"
                "The marker being present does not by itself resolve this dispute - "
                "decide whether the actual content genuinely satisfies the agreed "
                "deliverable given the client's specific objection. Respond with JSON "
                'only: {"verdict": "uphold" or "overturn", "reasoning": "one sentence"}. '
                '"uphold" means the deliverable is genuinely satisfied and the provider '
                'should be paid. "overturn" means the client\'s objection is valid and '
                "the client should be refunded."
            )
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            verdict = raw.get("verdict")
            if verdict not in ("uphold", "overturn"):
                verdict = "overturn"  # fail closed - an unparseable verdict shouldn't pay out
            reasoning = str(raw.get("reasoning", ""))[:400]
            return {"verdict": verdict, "reasoning": reasoning}

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            mine = leader_fn()
            return mine["verdict"] == leaders_res.calldata["verdict"]

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

    @gl.public.write
    def resolve_dispute(self, engagement_id: str) -> None:
        e = self._get(engagement_id)
        if gl.message.sender_address != e.provider:
            raise gl.vm.UserError("Only the provider can request dispute resolution")
        if e.status != "disputed":
            raise gl.vm.UserError(f"Engagement is not under dispute (status: {e.status})")

        result = self._adjudicate_dispute(e)
        e.resolution_note = result["reasoning"]

        if result["verdict"] == "uphold":
            e.status = "released"
            gl.get_contract_at(e.provider).emit_transfer(value=e.amount)
        else:
            e.status = "refunded"
            gl.get_contract_at(e.client).emit_transfer(value=e.amount)

    @gl.public.write
    def release(self, engagement_id: str) -> None:
        e = self._get(engagement_id)
        if e.status != "verified":
            raise gl.vm.UserError(f"Engagement is not verified (status: {e.status})")
        if self._now() <= e.verified_at + CHALLENGE_WINDOW_SECONDS:
            raise gl.vm.UserError("Challenge window is still open")

        e.status = "released"
        gl.get_contract_at(e.provider).emit_transfer(value=e.amount)

    @gl.public.write
    def reclaim_timeout(self, engagement_id: str) -> None:
        e = self._get(engagement_id)
        if gl.message.sender_address != e.client:
            raise gl.vm.UserError("Only the client can reclaim this engagement")
        if e.status != "funded":
            raise gl.vm.UserError(f"Engagement is not awaiting submission (status: {e.status})")
        if self._now() <= e.deadline:
            raise gl.vm.UserError("Deadline has not passed yet")

        e.status = "refunded"
        gl.get_contract_at(e.client).emit_transfer(value=e.amount)

    @gl.public.view
    def get_engagement(self, engagement_id: str) -> dict:
        e = self._get(engagement_id)
        return {
            "client": e.client.as_hex,
            "provider": e.provider.as_hex,
            "deliverable_description": e.deliverable_description,
            "verification_url": e.verification_url,
            "verification_marker": e.verification_marker,
            "amount": e.amount,
            "deadline": e.deadline,
            "status": e.status,
            "created_at": e.created_at,
            "submitted_at": e.submitted_at,
            "verified_at": e.verified_at,
            "dispute_reason": e.dispute_reason,
            "resolution_note": e.resolution_note,
            "challenge_deadline": e.verified_at + CHALLENGE_WINDOW_SECONDS if e.verified_at > 0 else 0,
        }

    @gl.public.view
    def get_all_engagement_ids(self) -> list:
        return list(self.engagement_ids)
