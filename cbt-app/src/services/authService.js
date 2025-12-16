import axios from 'axios'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || ''

const authClient = axios.create({
  baseURL: BACKEND_URL,
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
  timeout: 30000,
})

export const authService = {
  async signup({ username, email, password, referral_code, android_id }) {
    const response = await authClient.post('/api/auth/signup', {
      username,
      email,
      password,
      referral_code,
      android_id
    })
    return response.data
  },

  async login({ email, password, android_id }) {
    const response = await authClient.post('/api/auth/login', {
      email,
      password,
      android_id
    })
    return response.data
  },

  async forgotPassword(email) {
    const response = await authClient.post('/api/auth/forgot-password', { email })
    return response.data
  },

  async resetPassword(token, new_password) {
    const response = await authClient.post('/api/auth/reset-password', { token, new_password })
    return response.data
  },

  async getUser(userId) {
    const response = await authClient.get(`/api/auth/user/${userId}`)
    return response.data
  },

  async getReferrals(userId) {
    const response = await authClient.get(`/api/auth/referrals/${userId}`)
    return response.data
  },

  async getReferralDashboard() {
    const response = await authClient.get('/api/auth/referral-dashboard')
    return response.data
  },

  async updatePayment({ user_id, amount, reference }) {
    const response = await authClient.post('/api/auth/payment/update', {
      user_id,
      amount,
      reference
    })
    return response.data
  },

  async checkConfig() {
    const response = await authClient.get('/api/auth/check-config')
    return response.data
  }
}

export default authService
