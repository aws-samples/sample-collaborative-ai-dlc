import json
import shutil
import sys

query = json.load(sys.stdin)
if query["clean"] == "true":
    shutil.rmtree("builds/lambda-packaging", ignore_errors=True)
print(json.dumps({"epoch": query["epoch"]}))
