import { backendAcl, mqttJwtSecret, signMqttToken } from '../src/mqtt/mqtt-auth';

/** 測試裡模擬轉接器的 MQTT 連線：EMQX 開了認證（EMQX_JWT_SECRET）就帶一張全權限的 JWT */
export function testMqttAuth(name = 'e2e-test'): { username?: string; password?: string } {
  const secret = mqttJwtSecret();
  return secret ? { username: name, password: signMqttToken(name, backendAcl(), secret) } : {};
}
