import json
import boto3

def lambda_handler(event, context):
    api_client = boto3.client('apigateway')

    # Replace this with your actual Usage Plan ID
    usage_plan_id = 'ksbuqx'

    try:
        # Create a unique API key
        api_key_response = api_client.create_api_key(
            name='ApiKeyForUsagePlan',
            enabled=True
        )

        api_key_id = api_key_response['id']

        # Associate the API key with the usage plan
        api_client.create_usage_plan_key(
            usagePlanId=usage_plan_id,
            keyId=api_key_id,
            keyType='API_KEY'
        )

        return {
            'statusCode': 200,
            'body': json.dumps({
                'apiKeyId': api_key_id,
                'apiKey': api_key_response['value']
            })
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'Internal Server Error',
                'error': str(e)
            })
        }
