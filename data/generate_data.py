import random
from datetime import datetime, timedelta
import uuid
import json
from datetime import datetime, timedelta
def generate_data(num):
  dataset=[]
  for i in range(num):
    db_id = str(uuid.uuid4())
    account_id = "acc_{}".format(random.randint(100, 105))
    merchant_tx_ref = "MERCH_TXN_{}".format(1000 + i)
    session_id = "NMB_{}".format(random.randint(100000, 999999))
    base_time = datetime.now() - timedelta(hours=2)
    created_time = base_time + timedelta(minutes=i)
    delay_minutes = random.randint(1, 3)
    checked_time = created_time + timedelta(minutes=delay_minutes)
    created_at_str = created_time.isoformat() + "Z"
    last_checked_str = checked_time.isoformat() + "Z"
    bank_codes = ['042','037','054','022'] #Zenith, Access, GT, Sterling
    states=['settled','failed','pending']
    bank_code = random.choices(bank_codes)
    if bank_code == '054':
      state = random.choices(states, weights=[0.2,0.5,0.3])[0]
    else:
      state = random.choices(states, weights=[0.8,0.1,0.1])[0]
    direction = random.choice(['debit','credit'])
    expected_amount = random.randint(1000, 50000)*100
    if state == 'settled':
      threshold = random.choices([1,2,3], weights=[0.8,0.15,0.05])[0]
      if threshold == 1:
        amount=expected_amount
        settlement_match= "exact"
      elif threshold ==2:
        amount = expected_amount - 50000
        settlement_match = "under"
      else:
        amount = expected_amount + 50000
        settlement_match="over"
    else:
      amount =0
      settlement_match = "none"
    record={
        'id': db_id,
        'accountId': account_id,
        'merchantTxRef': merchant_tx_ref,
        'sessionId': session_id,
        'destinationBankCode':bank_code,
        'amount': amount,
        'settlementMatch':settlement_match,
        'state':state,
        'direction':direction,
        'createdAt': created_at_str,
        'lastCheckedAt': last_checked_str

    }
    dataset.append(record)
  return dataset

data = generate_data(50)
with open('synthetic_transactions.json', 'w') as json_file:
    json.dump(data, json_file, indent=2)

print("Data successfully saved to synthetic_transactions.json!")



