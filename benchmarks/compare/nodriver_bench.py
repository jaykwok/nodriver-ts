"""Python nodriver half of `node benchmarks/compare.ts`; prints one JSON object to stdout.

Usage: python nodriver_bench.py BASE_URL CHROME_PATH SAMPLES
"""

import asyncio
import json
import platform
import sys
import time
from importlib import metadata

import nodriver as uc
import psutil
from nodriver import cdp

BASE, CHROME, SAMPLES = sys.argv[1], sys.argv[2], int(sys.argv[3])


def progress(step: str) -> None:
    print(f"nodriver: {step}", file=sys.stderr, flush=True)


def now() -> float:
    return time.perf_counter() * 1000


async def loaded(tab, url: str) -> None:
    # nodriver's get() returns before the load event; poll until the document is complete.
    while True:
        state = await tab.evaluate("location.href + ' ' + document.readyState")
        if state == f"{url} complete":
            return
        await asyncio.sleep(0.005)


async def timed(count: int, fn) -> list[float]:
    samples = []
    for _ in range(count):
        start = now()
        await fn()
        samples.append(now() - start)
    return samples


async def main() -> None:
    result = {
        "runtime": f"Python {platform.python_version()}",
        "library": f"nodriver {metadata.version('nodriver')}",
        "websockets": metadata.version("websockets"),
    }
    starts = []
    progress("cold start")
    for _ in range(5):
        start = now()
        browser = await uc.start(headless=True, browser_executable_path=CHROME)
        tab = await browser.get(BASE + "/empty")
        await loaded(tab, BASE + "/empty")
        starts.append(now() - start)
        browser.stop()
        await asyncio.sleep(1)
    result["coldStart"] = starts

    browser = await uc.start(headless=True, browser_executable_path=CHROME)
    try:
        tab = await browser.get(BASE + "/buttons?n=1000")
        await loaded(tab, BASE + "/buttons?n=1000")
        progress("round trips")
        # The Browser object is its browser-level connection.
        for _ in range(20):
            await browser.send(cdp.browser.get_version())
        result["rtt"] = await timed(SAMPLES, lambda: browser.send(cdp.browser.get_version()))
        for _ in range(20):
            await tab.evaluate("1+1")
        result["evaluate"] = await timed(SAMPLES, lambda: tab.evaluate("1+1"))
        progress("query")
        for _ in range(5):
            await tab.select("#b500")
        result["query"] = await timed(SAMPLES // 2, lambda: tab.select("#b500"))

        async def navigate(index=[0]):
            index[0] += 1
            url = f"{BASE}/empty?n={index[0]}"
            await tab.get(url)
            await loaded(tab, url)

        progress("navigation")
        await navigate()
        result["navigation"] = await timed(20, navigate)

        progress("accessibility tree")
        await tab.get(BASE + "/buttons?n=10000")
        await loaded(tab, BASE + "/buttons?n=10000")
        await tab.send(cdp.accessibility.get_full_ax_tree())

        async def ax():
            nodes = await tab.send(cdp.accessibility.get_full_ax_tree())
            result["axNodes"] = len(nodes)

        result["axTree"] = await timed(5, ax)
        result["rss"] = psutil.Process().memory_info().rss
    finally:
        browser.stop()
    print(json.dumps(result))


if __name__ == "__main__":
    uc.loop().run_until_complete(main())
