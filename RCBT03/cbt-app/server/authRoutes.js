import express from 'express'
import bcrypt from 'bcrypt'
import { getSupabase, isSupabaseConfigured } from './supabaseClient.js'

const router = express.Router()
const SALT_ROUNDS = 10

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

router.post('/signup', async (req, res) => {
  try {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' })
    }

    const { username, email, password, referral_code, android_id } = req.body

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' })
    }

    const supabase = getSupabase()

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single()

    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS)
    const userReferralCode = generateReferralCode()

    let referrerId = null
    if (referral_code) {
      const { data: referrer } = await supabase
        .from('users')
        .select('id')
        .eq('referral_code', referral_code.toUpperCase())
        .single()
      
      if (referrer) {
        referrerId = referrer.id
      }
    }

    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert({
        username,
        email,
        password_hash,
        referral_code: userReferralCode,
        referred_by: referral_code ? referral_code.toUpperCase() : null,
        is_paid: false
      })
      .select()
      .single()

    if (insertError) {
      console.error('Insert error:', insertError)
      return res.status(500).json({ error: 'Failed to create user' })
    }

    if (referrerId && newUser) {
      await supabase
        .from('referrals')
        .insert({
          referrer_id: referrerId,
          referred_user_id: newUser.id,
          has_paid: false
        })
    }

    if (android_id && newUser) {
      await supabase
        .from('user_devices')
        .insert({
          user_id: newUser.id,
          android_id,
          is_active: true
        })
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
  }
})

router.post('/login', async (req, res) => {
  try {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' })
    }

    const { email, password, android_id } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const supabase = getSupabase()

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single()

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const validPassword = await bcrypt.compare(password, user.password_hash)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    if (android_id) {
      const { data: existingDevice } = await supabase
        .from('user_devices')
        .select('id')
        .eq('user_id', user.id)
        .eq('android_id', android_id)
        .single()

      if (existingDevice) {
        await supabase
          .from('user_devices')
          .update({ last_login: new Date().toISOString(), is_active: true })
          .eq('id', existingDevice.id)
      } else {
        await supabase
          .from('user_devices')
          .insert({
            user_id: user.id,
            android_id,
            is_active: true
          })
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
  }
})

router.get('/user/:id', async (req, res) => {
  try {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' })
    }

    const supabase = getSupabase()
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, referral_code, is_paid, created_at')
      .eq('id', req.params.id)
      .single()

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' })
    }

    res.json({ user })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/referrals/:userId', async (req, res) => {
  try {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' })
    }

    const supabase = getSupabase()
    
    const { data: user } = await supabase
      .from('users')
      .select('referral_code')
      .eq('id', req.params.userId)
      .single()

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    const { data: referrals } = await supabase
      .from('referrals')
      .select(`
        id,
        has_paid,
        created_at,
        referred_user:referred_user_id (
          id,
          username,
          email,
          is_paid
        )
      `)
      .eq('referrer_id', req.params.userId)

    const totalReferrals = referrals?.length || 0
    const paidReferrals = referrals?.filter(r => r.has_paid).length || 0

    res.json({
      referral_code: user.referral_code,
      total_referrals: totalReferrals,
      paid_referrals: paidReferrals,
      referrals: referrals || []
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/referral-dashboard', async (req, res) => {
  try {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' })
    }

    const supabase = getSupabase()

    const { data: users } = await supabase
      .from('users')
      .select('id, username, email, referral_code, is_paid, created_at')

    const { data: referrals } = await supabase
      .from('referrals')
      .select('referrer_id, referred_user_id, has_paid')

    const dashboard = users?.map(user => {
      const userReferrals = referrals?.filter(r => r.referrer_id === user.id) || []
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
    }) || []

    res.json({
      total_users: users?.length || 0,
      total_paid_users: users?.filter(u => u.is_paid).length || 0,
      users: dashboard
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/payment/update', async (req, res) => {
  try {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' })
    }

    const { user_id, amount, reference } = req.body

    if (!user_id) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    const supabase = getSupabase()

    await supabase
      .from('users')
      .update({ is_paid: true, updated_at: new Date().toISOString() })
      .eq('id', user_id)

    if (amount) {
      await supabase
        .from('payments')
        .insert({
          user_id,
          amount,
          status: 'success',
          reference
        })
    }

    await supabase
      .from('referrals')
      .update({ has_paid: true })
      .eq('referred_user_id', user_id)

    const { data: user } = await supabase
      .from('users')
      .select('id, username, email, is_paid')
      .eq('id', user_id)
      .single()

    res.json({
      success: true,
      message: 'Payment updated successfully',
      user
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/check-config', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    message: isSupabaseConfigured() 
      ? 'Supabase is configured and ready' 
      : 'Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables'
  })
})

export default router
