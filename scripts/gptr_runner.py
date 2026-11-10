"""Optional GPT Researcher runner in the caller's virtual environment."""
import argparse
import asyncio
from pathlib import Path
from runtime_config import load_config

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("query")
    parser.add_argument("-o", required=True)
    parser.add_argument("--report-type", default="research_report")
    parser.add_argument("--report-source", default="local")
    parser.add_argument("--no-bridge", action="store_true")
    args = parser.parse_args()
    load_config()
    from gpt_researcher import GPTResearcher
    researcher = GPTResearcher(query=args.query, report_type=args.report_type, report_source=args.report_source)
    await researcher.conduct_research()
    report = await researcher.write_report()
    Path(args.o).write_text(report, encoding="utf-8")

if __name__ == "__main__":
    asyncio.run(main())
