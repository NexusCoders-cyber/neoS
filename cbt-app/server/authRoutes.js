import express from 'express'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import pg from 'pg'

const { Pool } = pg
const router = express.Router()
const SALT_ROUNDS = 10

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
})

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex')
}

router.post('/signup', async (req, res) => {
  const client = await pool.connect()
  try {
    const { username, email, password, referral_code, android_id } = req.body

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' })
    }

    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    )

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS)
    const userReferralCode = generateReferralCode()

    let referrerId = null
    if (referral_code) {
      const referrer = await client.query(
        'SELECT id FROM users WHERE referral_code = $1',
        [referral_code.toUpperCase()]
      )
      if (referrer.rows.length > 0) {
        referrerId = referrer.rows[0].id
      }
    }

    const result = await client.query(
      `INSERT INTO users (username, email, password_hash, referral_code, referred_by, is_paid)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, email, referral_code, is_paid, created_at`,
      [username, email, password_hash, userReferralCode, referral_code?.toUpperCase() || null, false]
    )

    const newUser = result.rows[0]

    if (referrerId && newUser) {
      await client.query(
        'INSERT INTO referrals (referrer_id, referred_user_id, has_paid) VALUES ($1, $2, $3)',
        [referrerId, newUser.id, false]
      )
    }

    if (android_id && newUser) {
      await client.query(
        'INSERT INTO user_devices (user_id, android_id, is_active) VALUES ($1, $2, $3)',
        [newUser.id, android_id, true]
      )
    }

    res.json({
      success: true,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        referral_code: newUser.referral_code,
        is_paid: newUser.is_paid
      }
    })
  } catch (error) {
    console.error('Signup error:', error)
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.post('/login', async (req, res) => {
  const client = await pool.connect()
  try {
    const { email, password, android_id } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const result = await client.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]

    const validPassword = await bcrypt.compare(password, user.password_hash)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    if (android_id) {
      const existingDevice = await client.query(
        'SELECT id FROM user_devices WHERE user_id = $1 AND android_id = $2',
        [user.id, android_id]
      )

      if (existingDevice.rows.length > 0) {
        await client.query(
          'UPDATE user_devices SET last_login = NOW(), is_active = true WHERE id = $1',
          [existingDevice.rows[0].id]
        )
      } else {
        await client.query(
          'INSERT INTO user_devices (user_id, android_id, is_active) VALUES ($1, $2, $3)',
          [user.id, android_id, true]
        )
      }
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        referral_code: user.referral_code,
        is_paid: user.is_paid
      }
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.post('/forgot-password', async (req, res) => {
  const client = await pool.connect()
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const result = await client.query(
      'SELECT id, username FROM users WHERE email = $1',
      [email]
    )

    if (result.rows.length === 0) {
      return res.json({ 
        success: true, 
        message: 'If an account exists with this email, a reset code has been generated' 
      })
    }

    const user = result.rows[0]
    const resetToken = generateResetToken()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    await client.query(
      'UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false',
      [user.id]
    )

    await client.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, resetToken, expiresAt]
    )

    res.json({
      success: true,
      message: 'Password reset token generated',
      reset_token: resetToken,
      expires_in: '1 hour'
    })
  } catch (error) {
    console.error('Forgot password error:', error)
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.post('/reset-password', async (req, res) => {
  const client = await pool.connect()
  try {
    const { token, new_password } = req.body

    if (!token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' })
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    const result = await client.query(
      `SELECT prt.*, u.email, u.username 
       FROM password_reset_tokens prt 
       JOIN users u ON prt.user_id = u.id 
       WHERE prt.token = $1 AND prt.used = false AND prt.expires_at > NOW()`,
      [token]
    )

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }

    const resetRecord = result.rows[0]
    const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS)

    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [password_hash, resetRecord.user_id]
    )

    await client.query(
      'UPDATE password_reset_tokens SET used = true WHERE id = $1',
      [resetRecord.id]
    )

    res.json({
      success: true,
      message: 'Password has been reset successfully'
    })
  } catch (error) {
    console.error('Reset password error:', error)
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.get('/user/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    const result = await client.query(
      'SELECT id, username, email, referral_code, is_paid, created_at FROM users WHERE id = $1',
      [req.params.id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    res.json({ user: result.rows[0] })
  } catch (error) {
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.get('/referrals/:userId', async (req, res) => {
  const client = await pool.connect()
  try {
    const userResult = await client.query(
      'SELECT referral_code FROM users WHERE id = $1',
      [req.params.userId]
    )

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const referralsResult = await client.query(
      `SELECT r.id, r.has_paid, r.created_at, 
              u.id as referred_id, u.username as referred_username, 
              u.email as referred_email, u.is_paid as referred_is_paid
       FROM referrals r
       JOIN users u ON r.referred_user_id = u.id
       WHERE r.referrer_id = $1`,
      [req.params.userId]
    )

    const referrals = referralsResult.rows.map(r => ({
      id: r.id,
      has_paid: r.has_paid,
      created_at: r.created_at,
      referred_user: {
        id: r.referred_id,
        username: r.referred_username,
        email: r.referred_email,
        is_paid: r.referred_is_paid
      }
    }))

    res.json({
      referral_code: userResult.rows[0].referral_code,
      total_referrals: referrals.length,
      paid_referrals: referrals.filter(r => r.has_paid).length,
      referrals
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.get('/referral-dashboard', async (req, res) => {
  const client = await pool.connect()
  try {
    const usersResult = await client.query(
      'SELECT id, username, email, referral_code, is_paid, created_at FROM users'
    )

    const referralsResult = await client.query(
      'SELECT referrer_id, referred_user_id, has_paid FROM referrals'
    )

    const users = usersResult.rows
    const referrals = referralsResult.rows

    const dashboard = users.map(user => {
      const userReferrals = referrals.filter(r => r.referrer_id === user.id)
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        referral_code: user.referral_code,
        is_paid: user.is_paid,
        total_referrals: userReferrals.length,
        paid_referrals: userReferrals.filter(r => r.has_paid).length,
        created_at: user.created_at
      }
    })

    res.json({
      total_users: users.length,
      total_paid_users: users.filter(u => u.is_paid).length,
      users: dashboard
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.post('/payment/update', async (req, res) => {
  const client = await pool.connect()
  try {
    const { user_id, amount, reference } = req.body

    if (!user_id) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    await client.query(
      'UPDATE users SET is_paid = true, updated_at = NOW() WHERE id = $1',
      [user_id]
    )

    if (amount) {
      await client.query(
        'INSERT INTO payments (user_id, amount, status, reference) VALUES ($1, $2, $3, $4)',
        [user_id, amount, 'success', reference]
      )
    }

    await client.query(
      'UPDATE referrals SET has_paid = true WHERE referred_user_id = $1',
      [user_id]
    )

    const result = await client.query(
      'SELECT id, username, email, is_paid FROM users WHERE id = $1',
      [user_id]
    )

    res.json({
      success: true,
      message: 'Payment updated successfully',
      user: result.rows[0]
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

router.get('/check-config', (req, res) => {
  const configured = !!process.env.DATABASE_URL
  res.json({
    configured,
    message: configured 
      ? 'Database is configured and ready' 
      : 'DATABASE_URL environment variable not set'
  })
})

export default router
