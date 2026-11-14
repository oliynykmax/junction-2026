import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.exceptions import ClientError


client = boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT"])
bucket = os.environ["CELLD_BUCKET"].removeprefix("s3://")
if "/" in bucket:
    raise ValueError("Use a bucket without a prefix for this probe")
key = "qualification/" + str(uuid.uuid4())
body = os.urandom(16384)


def conflict(call):
    try:
        call()
    except ClientError as error:
        assert error.response["ResponseMetadata"]["HTTPStatusCode"] in (409, 412)
    else:
        raise AssertionError("Object store accepted a conflicting conditional write")


try:
    created = client.put_object(Bucket=bucket, Key=key, Body=body, IfNoneMatch="*")
    conflict(lambda: client.put_object(Bucket=bucket, Key=key, Body=b"wrong", IfNoneMatch="*"))
    result = client.get_object(Bucket=bucket, Key=key)
    assert result["Body"].read() == body
    assert result["ETag"] == created["ETag"]
    assert client.get_object(Bucket=bucket, Key=key, Range="bytes=17-1024")["Body"].read() == body[17:1025]
    listed = client.list_objects_v2(Bucket=bucket, Prefix=key)
    assert any(entry["Key"] == key for entry in listed.get("Contents", []))

    def update(index):
        try:
            client.put_object(Bucket=bucket, Key=key, Body=str(index).encode(), IfMatch=created["ETag"])
            return True
        except ClientError as error:
            assert error.response["ResponseMetadata"]["HTTPStatusCode"] in (409, 412)
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(update, range(8))) == 1
    conflict(lambda: client.put_object(Bucket=bucket, Key=key, Body=b"stale", IfMatch=created["ETag"]))
    print("PASS conditional create, read-after-write, ETag, exact ranged read, list consistency, single CAS winner, stale-write rejection")
finally:
    client.delete_object(Bucket=bucket, Key=key)
