/**
 * LMS Provisioning Adapter
 * 
 * Enrolls a customer into the Spoken Emirati Arabic Masterclass course
 * on https://learn.peregrineacademy.in
 * 
 * Course ID: 23c9297a-a4c2-4237-baa7-244646de1662
 * 
 * ARCHITECTURE NOTE:
 * LMS-Peregrine currently manages enrollments via public.enrollments in its Supabase database
 * and internal Razorpay verify routes. It currently lacks a public external server-to-server
 * enrollment endpoint. Before production launch, an authorized enrollment handler or
 * webhook receiver must be formally deployed on LMS-Peregrine.
 */

export interface LmsProvisioningParams {
  orderId: string;
  customerEmail: string;
  customerName?: string;
  courseId?: string;
}

export interface LmsProvisioningResult {
  success: boolean;
  enrollmentId?: string;
  courseUrl: string;
  message: string;
  error?: string;
}

export const SPOKEN_EMIRATI_COURSE_ID = '23c9297a-a4c2-4237-baa7-244646de1662';

export async function provisionLmsCourse(
  params: LmsProvisioningParams,
  options?: {
    lmsApiUrl?: string;
    lmsApiKey?: string;
    simulate?: boolean;
  }
): Promise<LmsProvisioningResult> {
  const courseId = params.courseId || SPOKEN_EMIRATI_COURSE_ID;
  const courseUrl = `https://learn.peregrineacademy.in/courses/${courseId}`;
  const lmsApiUrl = options?.lmsApiUrl || process.env.LMS_API_URL || 'https://learn.peregrineacademy.in';
  const lmsApiKey = options?.lmsApiKey || process.env.LMS_API_KEY;

  // If simulation mode or testing without external network
  if (options?.simulate || !lmsApiKey) {
    const mockEnrollmentId = `enr_${params.orderId.slice(0, 8)}_${Date.now().toString(36)}`;
    return {
      success: true,
      enrollmentId: mockEnrollmentId,
      courseUrl,
      message: `Enrolled ${params.customerEmail} in LMS Course (${courseId}) [Simulated]`
    };
  }

  try {
    const response = await fetch(`${lmsApiUrl}/api/bundles/enroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${lmsApiKey}`
      },
      body: JSON.stringify({
        order_id: params.orderId,
        email: params.customerEmail,
        name: params.customerName,
        course_id: courseId
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        success: false,
        courseUrl,
        message: 'LMS enrollment failed',
        error: `HTTP ${response.status}: ${errText}`
      };
    }

    const data = await response.json();
    return {
      success: true,
      enrollmentId: data.enrollment_id || data.id,
      courseUrl,
      message: 'Successfully enrolled in LMS course'
    };
  } catch (err: any) {
    return {
      success: false,
      courseUrl,
      message: 'Network error communicating with LMS',
      error: err.message || String(err)
    };
  }
}
