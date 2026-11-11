"""Experiment 28: drive the firmware emulator through the debug link.

Run with the Python environment of the firmware checkout, which provides trezorlib (LGPLv3); nothing
from that checkout is copied here:

    <checkout>/.venv/bin/python run.py --inputs inputs --out results/1-first-run.json

The emulator must already be running with its debug link, loaded with the all-`all` test seed, on
UDP port 21324 (debug link on 21325). For every typed-data input it signs twice: on the full path,
answering every "show more" prompt by opening it, and on the short path, declining every one. Every
screen is recorded with its button-request name, title and text. Then the four delegate cases.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from trezorlib import device, ethereum
from trezorlib.debuglink import LayoutType, TrezorTestContext
from trezorlib.exceptions import TrezorFailure
from trezorlib.messages import EthereumAuth7702
from trezorlib.tools import parse_path
from trezorlib.transport.udp import UdpTransport

PATH = "m/44h/60h/0h/0/0"
SIMPLE7702 = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9"
UNNAMED = "0x000000000000000000000000000000000000dEaD"
ZERO = "0x0000000000000000000000000000000000000000"
SHOW_PROMPTS = ("should_show_struct", "should_show_array")


def connect(port: int) -> TrezorTestContext:
    transport = UdpTransport.find_by_path(f"udp:127.0.0.1:{port}")
    return TrezorTestContext(transport, auto_interact=True)


def make_flow(ctx: TrezorTestContext, screens: list, mode: str):
    """A generic input flow: records every page of every prompt, then answers it."""

    def show_more() -> None:
        lt = ctx.debug.layout_type
        if lt is LayoutType.Bolt:
            ctx.debug.click((143, 167))
        elif lt is LayoutType.Caesar:
            ctx.debug.press_left()
            ctx.debug.button_actions.navigate_to_menu_item(0)
        else:  # Delizia, Eckhart
            ctx.debug.click(ctx.debug.screen_buttons.menu())
            ctx.debug.button_actions.navigate_to_menu_item(0)

    def flow():
        while True:
            br = yield
            pages = br.pages or 1
            for i in range(pages):
                lay = ctx.debug.read_layout()
                screens.append({"prompt": br.name, "page": i + 1, "pages": pages, "title": lay.title(), "text": lay.text_content()})
                if i < pages - 1:
                    ctx.debug.swipe_up()
            if br.name in SHOW_PROMPTS and mode == "full":
                show_more()
            else:
                ctx.debug.press_yes()

    return flow


def sign_typed(ctx, session, td: dict, mode: str) -> dict:
    screens: list = []
    t0 = time.time()
    out: dict = {"mode": mode}
    try:
        with ctx:
            ctx.set_input_flow(make_flow(ctx, screens, mode))
            r = ethereum.sign_typed_data(session, parse_path(PATH), td, metamask_v4_compat=True)
        out.update(signed=True, address=r.address, signature="0x" + r.signature.hex())
    except TrezorFailure as e:
        out.update(signed=False, refusal=str(e.message), code=str(e.code))
    except Exception as e:  # recorded, never hidden
        out.update(signed=False, error=f"{type(e).__name__}: {e}")
    out.update(screens=screens, screen_count=len(screens), seconds=round(time.time() - t0, 2))
    return out


def sign_7702(ctx, session, address: str, chain_id: int, delegate: str, nonce: int = 0) -> dict:
    screens: list = []
    out: dict = {"chain_id": chain_id, "delegate": delegate, "tx_nonce": nonce}
    try:
        with ctx:
            ctx.set_input_flow(make_flow(ctx, screens, "full"))
            r = ethereum.sign_tx_eip1559(
                session, n=parse_path(PATH), nonce=nonce, gas_limit=100_000, to=address, value=0,
                chain_id=chain_id, max_gas_fee=2_000_000_000, max_priority_fee=1_000_000_000,
                auth7702=EthereumAuth7702(delegate=delegate),
            )
        tuples = [[x.hex() for x in t] for t in (getattr(r, "auth7702_list", None) or [])]
        out.update(signed=True, tx_signature={"v": r.v, "r": r.r.hex(), "s": r.s.hex()} if hasattr(r, "r") else repr(r), auth_tuples=tuples)
    except TrezorFailure as e:
        out.update(signed=False, refusal=str(e.message), code=str(e.code))
    except Exception as e:
        out.update(signed=False, error=f"{type(e).__name__}: {e}")
    out.update(screens=screens, screen_count=len(screens))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", default="inputs")
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", type=int, default=21324)
    ap.add_argument("--only", default="", help="comma-separated vector names, for a dry run")
    ap.add_argument("--delegates-only", action="store_true", help="skip the vectors (deviation 1)")
    ap.add_argument("--experimental", action="store_true", help="turn on the device's experimental features first (deviation 1)")
    a = ap.parse_args()

    ctx = connect(a.port)
    session = ctx.get_session()
    address = ethereum.get_address(session, parse_path(PATH))
    features = ctx.client.features
    doc: dict = {
        "firmware": f"{features.major_version}.{features.minor_version}.{features.patch_version}",
        "model": str(features.internal_model),
        "layout": str(ctx.debug.layout_type),
        "path": PATH,
        "address": address,
        "vectors": [],
        "delegates": [],
    }
    if a.experimental:
        screens: list = []
        with ctx:
            ctx.set_input_flow(make_flow(ctx, screens, "full"))
            device.apply_settings(session, experimental_features=True)
        doc["experimental_features"] = {"enabled": True, "screens": screens}
        print("experimental features enabled", flush=True)
    only = {x for x in a.only.split(",") if x}
    for f in ([] if a.delegates_only else sorted(Path(a.inputs).glob("*/*.json"))):
        v = json.loads(f.read_text())
        if only and v["name"] not in only:
            continue
        row = {"set": v["set"], "name": v["name"], "executionDigest": v["executionDigest"],
               "frames": len(v["typedData"]["message"]["frames"])}
        for mode in ("full", "short"):
            row[mode] = sign_typed(ctx, session, v["typedData"], mode)
            print(f"{v['set']}/{v['name']} {mode}: signed={row[mode]['signed']} screens={row[mode]['screen_count']}", flush=True)
        doc["vectors"].append(row)

    if not only:
        cases = [("a", 1, SIMPLE7702), ("b", 1, UNNAMED), ("c", 1, ZERO), ("d", 8141, SIMPLE7702)]
        for label, chain, delegate in cases:
            r = sign_7702(ctx, session, address, chain, delegate)
            r["case"] = label
            print(f"7702 ({label}) chain {chain} {delegate}: signed={r['signed']} {r.get('refusal', '')}", flush=True)
            doc["delegates"].append(r)

    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    sys.exit(main())
